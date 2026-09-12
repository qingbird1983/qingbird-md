import { describe, expect, it } from "vitest";
import {
  baseName,
  dirName,
  folderOfPath,
  joinUnderRoot,
  normPath,
  parentLabel,
  relLabel,
  underPath,
} from "./wsPath";

describe("baseName / dirName", () => {
  it("取末级名", () => {
    expect(baseName("C:\\a\\b.md")).toBe("b.md");
    expect(baseName("C:\\b.md")).toBe("b.md");
  });

  it("盘根的父目录仍是盘根，不产出 `C:`", () => {
    expect(dirName("C:\\foo.md")).toBe("C:\\");
    expect(dirName("C:\\a\\b.md")).toBe("C:\\a");
  });
});

describe("normPath", () => {
  it("去掉尾部多余分隔符", () => {
    expect(normPath("C:\\a\\b\\")).toBe("C:\\a\\b");
    expect(normPath("C:\\a\\b///")).toBe("C:\\a\\b");
  });

  it("盘根保留原样（否则会退化成空串）", () => {
    expect(normPath("C:\\")).toBe("C:\\");
    expect(normPath("C:")).toBe("C:");
  });

  it("无尾分隔符时原样返回", () => {
    expect(normPath("C:\\a\\b")).toBe("C:\\a\\b");
  });
});

describe("joinUnderRoot", () => {
  it("自动补分隔符", () => {
    expect(joinUnderRoot("C:\\a", "b.md")).toBe("C:\\a\\b.md");
  });

  it("root 自带尾分隔符时不重复补", () => {
    expect(joinUnderRoot("C:\\a\\", "b.md")).toBe("C:\\a\\b.md");
    expect(joinUnderRoot("C:\\", "b.md")).toBe("C:\\b.md");
  });
});

describe("underPath", () => {
  it("相等时算落在其内", () => {
    expect(underPath("C:\\a", "C:\\a")).toBe(true);
  });

  it("前缀相同但边界不是分隔符 → 不算落在其内", () => {
    expect(underPath("C:\\ab\\x.md", "C:\\a")).toBe(false);
    expect(underPath("C:\\ab", "C:\\a")).toBe(false);
  });

  it("真正的子路径算落在其内", () => {
    expect(underPath("C:\\a\\b.md", "C:\\a")).toBe(true);
  });

  it("盘根自带尾分隔符也能命中（这里最容易写错）", () => {
    expect(underPath("C:\\a.md", "C:\\")).toBe(true);
    expect(underPath("C:\\a\\b.md", "C:\\")).toBe(true);
    expect(underPath("C:\\", "C:\\")).toBe(true);
  });

  it("空 dir 一律不匹配（防 `startsWith('')` 恒真）", () => {
    expect(underPath("C:\\a.md", "")).toBe(false);
  });

  it("短路径不会反吃到长 dir", () => {
    expect(underPath("C:\\a", "C:\\a\\b")).toBe(false);
  });
});

describe("folderOfPath", () => {
  const folders = [
    { path: "C:\\a" },
    { path: "C:\\a\\nested" },
    { path: "D:\\other" },
  ];

  it("取最长匹配的那个根（支持根之间嵌套）", () => {
    expect(folderOfPath(folders, "C:\\a\\nested\\x.md")?.path).toBe("C:\\a\\nested");
    expect(folderOfPath(folders, "C:\\a\\y.md")?.path).toBe("C:\\a");
  });

  it("不在任何根内时返回 null", () => {
    expect(folderOfPath(folders, "E:\\z.md")).toBeNull();
  });

  it("空列表返回 null", () => {
    expect(folderOfPath([], "C:\\a\\y.md")).toBeNull();
  });
});

describe("relLabel", () => {
  it("去掉根前缀与紧随的分隔符", () => {
    expect(relLabel("C:\\a\\sub\\x.md", "C:\\a")).toBe("sub\\x.md");
    expect(relLabel("C:\\a\\x.md", "C:\\")).toBe("a\\x.md");
  });

  it("不在根内时原样返回（不做误导性裁剪）", () => {
    expect(relLabel("E:\\z.md", "C:\\a")).toBe("E:\\z.md");
  });
});

describe("parentLabel", () => {
  it("取父目录末级名", () => {
    expect(parentLabel("C:\\a\\proj\\x.md")).toBe("proj");
  });

  it("盘根下的文件没有可显示的父名", () => {
    expect(parentLabel("C:\\x.md")).toBe("");
  });
});
