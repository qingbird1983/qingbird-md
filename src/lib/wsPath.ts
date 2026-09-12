// 工作区路径工具（纯函数，可离线单测）。
//
// 路径一律是后端 PathBuf 的原生分隔符字符串（Windows 上是 `\`）。前端只做
// 字符串层面的拼接与归属判定，不做规范化重写——真正的路径语义在后端。
//
// 这里最容易出错的是**前缀匹配的边界**：`C:\a` 必须不匹配 `C:\ab`，
// 所以所有归属判定都走 underPath（要求边界处就是分隔符或恰好等长）。
// 另一个坑是盘根 `C:\` 自带尾分隔符，naive 的「取下一个字符」判定会全部返 false。

/** 末级名（`C:\a\b.md` → `b.md`）。 */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 父目录。盘根单独处理（`C:\foo` → `C:\`），避免算出 `C:` 这种非法路径。 */
export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i < 0) return p;
  if (i === 2 && p[1] === ":") return p.slice(0, 3);
  return p.slice(0, i);
}

/** 去掉尾部多余分隔符；盘根（`C:\` / `C:`）保留原样。 */
export function normPath(p: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(p)) return p;
  return p.replace(/[\\/]+$/, "");
}

/** 在 root 下拼一个一级名称，root 自带尾分隔符时不重复补。 */
export function joinUnderRoot(root: string, name: string): string {
  return /[\\/]$/.test(root) ? root + name : `${root}\\${name}`;
}

/** p 是否落在 dir 内（含相等）。以分隔符为界：`C:\a` 不匹配 `C:\ab`。 */
export function underPath(p: string, dir: string): boolean {
  if (!dir || !p.startsWith(dir)) return false;
  if (p.length === dir.length) return true;
  const last = dir[dir.length - 1];
  // dir 自带尾分隔符（如盘根 `C:\`）：前缀命中即已落在其内
  if (last === "\\" || last === "/") return true;
  const next = p[dir.length];
  return next === "\\" || next === "/";
}

/** 找出包含该路径的条目（最长前缀优先，支持多个根相互嵌套）。 */
export function folderOfPath<T extends { path: string }>(folders: T[], p: string): T | null {
  let best: T | null = null;
  for (const f of folders) {
    if (!underPath(p, f.path)) continue;
    if (!best || f.path.length > best.path.length) best = f;
  }
  return best;
}

/** 相对所属根的展示路径（命令面板检索键）；不在根内时原样返回。 */
export function relLabel(path: string, root: string): string {
  if (!underPath(path, root)) return path;
  return path.slice(root.length).replace(/^[\\/]/, "");
}

/** 父目录的末级名（最近打开列表里同名文件的消歧后缀）。 */
export function parentLabel(p: string): string {
  const dir = dirName(p);
  if (dir === p) return "";
  return baseName(dir);
}
