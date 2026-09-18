#!/usr/bin/env python3
"""Publish a qingbird-md release to Gitee (origin remote).

Setup (once):
    python scripts/publish-gitee.py --set-token <GITEE_PERSONAL_TOKEN>

Publish (run from anywhere inside the repo):
    python scripts/publish-gitee.py                # build installer, then publish
    python scripts/publish-gitee.py --skip-build   # reuse existing installer
    python scripts/publish-gitee.py --dry-run      # print the plan, change nothing
    python scripts/publish-gitee.py --force        # replace an existing release

Token resolution order: --token > $GITEE_TOKEN > %APPDATA%/qingbird-md/gitee-token
The token never enters the repository: it lives outside the working tree and
release/ is git-ignored.

Pipeline:
    1. verify tracked files are clean (no uncommitted changes)
    2. verify version consistency across package.json / tauri.conf.json / Cargo.toml
    3. verify tag vX.Y.Z exists locally and has been pushed to origin (Gitee)
    4. extract release notes from CHANGELOG.md
    5. build the NSIS installer unless --skip-build
    6. stage installer as release/qingbird-md-setup-<version>-x64.exe
    7. create the Gitee release (idempotent: --force deletes and recreates)
    8. upload the installer as a release attachment
"""
import argparse
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

REPO_OWNER = "muyan1983"
REPO_NAME = "qingbird-md"
API_BASE = "https://gitee.com/api/v5"
BRANCH = "main"

REPO_ROOT = Path(__file__).resolve().parent.parent
# Cargo workspace root is the repo root, so `npx tauri build` emits the NSIS
# bundle under <repo-root>/target/... (NOT src-tauri/target).
NSIS_DIR = REPO_ROOT / "target" / "release" / "bundle" / "nsis"
RELEASE_DIR = REPO_ROOT / "release"
NOTES_SCRIPT = REPO_ROOT / ".github" / "scripts" / "extract-notes.py"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------
# token
# --------------------------------------------------------------------------
def token_path() -> Path:
    """Token lives next to the app settings, outside the working tree.

    On Windows this resolves to %APPDATA%\\qingbird-md\\gitee-token. APPDATA is
    not always exported (e.g. Git Bash), so fall back to the well-known path
    instead of silently diverging between shells.
    """
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            appdata = str(Path.home() / "AppData" / "Roaming")
        return Path(appdata) / "qingbird-md" / "gitee-token"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "qingbird-md" / "gitee-token"


def save_token(token: str) -> int:
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token.strip(), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    log(f"Token saved to {path}")
    log("It lives outside the repository and is never committed.")
    return 0


def resolve_token(cli_token: str | None) -> str:
    if cli_token:
        return cli_token.strip()
    env = os.environ.get("GITEE_TOKEN")
    if env and env.strip():
        return env.strip()
    path = token_path()
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    fail(
        "no Gitee token found. Run "
        "`python scripts/publish-gitee.py --set-token <TOKEN>` "
        "or set the GITEE_TOKEN environment variable."
    )


# --------------------------------------------------------------------------
# git / version
# --------------------------------------------------------------------------
def git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        fail(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def check_clean_worktree(allow_dirty: bool) -> None:
    dirty = git("status", "--porcelain", "--untracked-files=no")
    if dirty:
        if allow_dirty:
            log("WARNING: worktree has uncommitted changes (--allow-dirty).")
            for line in dirty.splitlines():
                log(f"         {line}")
        else:
            fail(
                "worktree has uncommitted changes:\n"
                + dirty
                + "\nCommit them first, or pass --allow-dirty."
            )
    else:
        log("[1/7] Worktree clean")


def read_cargo_version(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    start_match = re.search(r"^\[package\]\s*$", text, re.MULTILINE)
    if not start_match:
        fail(f"no [package] section in {path}")
    start = start_match.end()
    next_section = re.search(r"^\[[^\]]+\]\s*$", text[start:], re.MULTILINE)
    end = start + next_section.start() if next_section else len(text)
    version_match = re.search(
        r"^version\s*=\s*\"([^\"]+)\"", text[start:end], re.MULTILINE
    )
    if not version_match:
        fail(f"no version field in [package] section of {path}")
    return version_match.group(1)


def resolve_version(cli_version: str | None) -> str:
    if cli_version:
        return cli_version.lstrip("v")
    pkg = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    tauri = json.loads(
        (REPO_ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )["version"]
    cargo = read_cargo_version(REPO_ROOT / "src-tauri" / "Cargo.toml")
    if len({pkg, tauri, cargo}) != 1:
        fail(
            "version mismatch across sources: "
            f"package.json={pkg}, tauri.conf.json={tauri}, Cargo.toml={cargo}"
        )
    log(f"[2/7] Version consistent: {pkg}")
    return pkg


def check_tag(version: str, skip_tag_check: bool) -> None:
    tag = f"v{version}"
    if skip_tag_check:
        log(f"[3/7] Tag check skipped ({tag})")
        return
    proc = subprocess.run(
        ["git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        fail(
            f"tag {tag} does not exist locally. "
            f"Create it with: git tag -a {tag} -m 'Release {tag}'"
        )
    remote_tags = git("ls-remote", "--tags", "origin")
    if f"refs/tags/{tag}" not in remote_tags:
        fail(
            f"tag {tag} exists locally but is not pushed to origin (Gitee). "
            f"Push it with: git push origin {tag}"
        )
    log(f"[3/7] Tag {tag} present locally and on origin")


def extract_notes(version: str, output: Path) -> None:
    if not NOTES_SCRIPT.is_file():
        fail(f"missing {NOTES_SCRIPT}")
    proc = subprocess.run(
        [sys.executable, str(NOTES_SCRIPT), "--version", version,
         "--changelog", str(CHANGELOG), "--output", str(output)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        fail(f"extract-notes.py failed: {proc.stderr.strip()}")
    body = output.read_text(encoding="utf-8")
    log(f"[4/7] Release notes extracted ({len(body)} chars) -> {output.name}")


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def build_installer() -> None:
    log("[5/7] Building installer: npx tauri build  (this takes several minutes)")
    proc = subprocess.run(["npx", "tauri", "build"], cwd=REPO_ROOT)
    if proc.returncode != 0:
        fail(f"npx tauri build failed with exit code {proc.returncode}")
    log("[5/7] Build finished")


def stage_installer(version: str) -> Path:
    if not NSIS_DIR.is_dir():
        fail(f"NSIS output directory not found: {NSIS_DIR}")
    candidates = sorted(
        NSIS_DIR.glob("*.exe"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not candidates:
        fail(f"no .exe found under {NSIS_DIR}")
    src = candidates[0]
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    dest = RELEASE_DIR / f"qingbird-md-setup-{version}-x64.exe"
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    size_mb = dest.stat().st_size / 1024 / 1024
    log(f"[6/7] Installer staged: {dest.name} ({size_mb:.2f} MB)")
    return dest


# --------------------------------------------------------------------------
# Gitee API
# --------------------------------------------------------------------------

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Block all HTTP redirects — SSRF defense.

    A redirect could send the request to an internal host even though the
    original URL pointed at gitee.com. Failing hard on any redirect makes
    the allowlist check on the *original* URL sufficient.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl, *args):
        fail(f"refusing HTTP {code} redirect to {newurl} (SSRF defense)")


# Install the no-redirect opener once at import time so every urlopen in
# this module inherits it — callers cannot forget to opt in.
urllib.request.install_opener(
    urllib.request.build_opener(_NoRedirectHandler)
)


def _assert_gitee_url(url: str) -> None:
    """SSRF guard: validate scheme, hostname, and resolved IPs.

    Three layers:
    1. **Protocol + hostname** via urlparse — rejects non-HTTPS and
       non-gitee.com hosts, including ``https://gitee.com@evil.com/``.
    2. **IP resolution** — resolves the hostname and rejects
       private, loopback, link-local, or reserved addresses (partial
       DNS-rebinding defense: if the resolved IP is non-public we bail).
    3. **Redirect blocking** — the module-level ``_NoRedirectHandler``
      ensures the request never follows a redirect to another host.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "gitee.com":
        fail(
            f"refusing non-allowlisted URL "
            f"(expected https://gitee.com/...): {url}"
        )
    # Resolve and reject non-public IPs (DNS rebinding defense).
    try:
        infos = socket.getaddrinfo(
            parsed.hostname, 443, proto=socket.IPPROTO_TCP
        )
    except socket.gaierror:
        fail(f"could not resolve hostname: {parsed.hostname}")
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
        ):
            fail(
                f"refusing non-public IP {ip} resolved for "
                f"{parsed.hostname} (SSRF defense)"
            )


def api_request(url: str, method: str, token: str,
                payload: dict | None = None) -> dict | list | None:
    data = None
    headers = {"User-Agent": "qingbird-md-publisher"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    _assert_gitee_url(url)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        fail(f"Gitee API {method} {url} -> HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"Gitee API {method} {url} -> network error: {exc.reason}")


def api_upload(release_id: int, token: str, path: Path) -> dict:
    url = f"{API_BASE}/repos/{REPO_OWNER}/{REPO_NAME}/releases/{release_id}/attach_files"
    _assert_gitee_url(url)
    boundary = "----qingbird" + uuid.uuid4().hex
    payload = path.read_bytes()
    body = b""
    body += f"--{boundary}\r\n".encode("utf-8")
    body += b'Content-Disposition: form-data; name="access_token"\r\n\r\n'
    body += token.encode("utf-8") + b"\r\n"
    body += f"--{boundary}\r\n".encode("utf-8")
    body += (
        f'Content-Disposition: form-data; name="file"; '
        f'filename="{path.name}"\r\n'
    ).encode("utf-8")
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += payload + b"\r\n"
    body += f"--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "qingbird-md-publisher",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        fail(f"upload failed HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"upload failed: {exc.reason}")


def find_existing_release(tag: str, token: str) -> dict | None:
    url = f"{API_BASE}/repos/{REPO_OWNER}/{REPO_NAME}/releases/tags/{tag}"
    _assert_gitee_url(url)
    req = urllib.request.Request(url, method="GET",
                                 headers={"User-Agent": "qingbird-md-publisher"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        fail(f"lookup release {tag} -> HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"lookup release {tag} -> network error: {exc.reason}")


def publish(version: str, notes_path: Path, installer: Path,
            token: str, force: bool, dry_run: bool) -> int:
    tag = f"v{version}"
    notes = notes_path.read_text(encoding="utf-8")

    if dry_run:
        log("[7/7] DRY RUN - nothing was sent to Gitee")
        log(f"       would create release {tag} (name: qingbird-md {tag})")
        log(f"       notes file : {notes_path} ({len(notes)} chars)")
        log(f"       upload file: {installer} "
            f"({installer.stat().st_size} bytes)")
        log(f"       target     : https://gitee.com/{REPO_OWNER}/{REPO_NAME}/releases")
        return 0

    existing = find_existing_release(tag, token)
    if existing:
        if not force:
            fail(
                f"release {tag} already exists "
                f"(https://gitee.com/{REPO_OWNER}/{REPO_NAME}/releases/tag/{tag}). "
                "Re-run with --force to delete and recreate it."
            )
        url = (f"{API_BASE}/repos/{REPO_OWNER}/{REPO_NAME}"
               f"/releases/{existing['id']}?access_token={token}")
        api_request(url, "DELETE", token)
        log(f"[7/7] Deleted existing release {tag}")

    payload = {
        "access_token": token,
        "tag_name": tag,
        "name": f"qingbird-md {tag}",
        "body": notes,
        "target_commitish": BRANCH,
        "prerelease": False,
    }
    url = f"{API_BASE}/repos/{REPO_OWNER}/{REPO_NAME}/releases"
    created = api_request(url, "POST", token, payload)
    release_id = created["id"]
    log(f"[7/7] Release created: {created.get('html_url', tag)} (id={release_id})")

    log("       Uploading installer ...")
    api_upload(release_id, token, installer)
    log("       Installer uploaded")

    log("")
    log(f"Done: https://gitee.com/{REPO_OWNER}/{REPO_NAME}/releases/tag/{tag}")
    return 0


# --------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish a qingbird-md release to Gitee.")
    parser.add_argument("--set-token", metavar="TOKEN",
                        help="store a Gitee personal access token and exit")
    parser.add_argument("--token", help="use this token instead of the stored one")
    parser.add_argument("--version", help="override version (default: read from sources)")
    parser.add_argument("--skip-build", action="store_true",
                        help="reuse the existing NSIS installer")
    parser.add_argument("--skip-tag-check", action="store_true",
                        help="do not require the tag to exist / be pushed")
    parser.add_argument("--allow-dirty", action="store_true",
                        help="allow publishing with uncommitted changes")
    parser.add_argument("--force", action="store_true",
                        help="delete and recreate an existing release")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan without contacting Gitee")
    args = parser.parse_args()

    if args.set_token:
        return save_token(args.set_token)

    check_clean_worktree(args.allow_dirty)
    version = resolve_version(args.version)
    check_tag(version, args.skip_tag_check)

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    notes_path = RELEASE_DIR / f"RELEASE-NOTES-{version}.md"
    extract_notes(version, notes_path)

    if args.skip_build:
        log("[5/7] Build skipped (--skip-build)")
        installer = RELEASE_DIR / f"qingbird-md-setup-{version}-x64.exe"
        if not installer.is_file():
            fail(
                f"{installer} not found. "
                "Run without --skip-build, or build the installer first."
            )
        size_mb = installer.stat().st_size / 1024 / 1024
        log(f"[6/7] Installer staged: {installer.name} ({size_mb:.2f} MB)")
    else:
        build_installer()
        installer = stage_installer(version)

    if args.dry_run:
        return publish(version, notes_path, installer, "", False, True)

    token = resolve_token(args.token)
    return publish(version, notes_path, installer, token, args.force, False)


if __name__ == "__main__":
    sys.exit(main())
