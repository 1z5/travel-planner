// Trip Check CLI 的单元测试（不起进程：直接调 run()，IO 全注入）
//
// 覆盖重点不是 happy path，而是这个工具会被 CI/agent 依赖的契约：
// 退出码语义、--json 机读输出、确定性（同一示例两次跑出同一凭据）、错误路径。

import { describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args";
import { exitCodeFor, formatReport } from "../../cli/report-format";
import { run, type CliIO } from "../../cli/trip-check";
import { credentialOf } from "../../lib/verify/credential";
import { verifyDocument } from "../../lib/verify/engine";
import { getSample } from "../../lib/verify/samples";

function makeIO(stdinText = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async () => stdinText,
    isTTY: false,
    env: {},
  };
  return { io, out, err };
}

describe("parseArgs", () => {
  it("默认空参报错并给出原因", () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--sample");
  });

  it("文件与 --sample 互斥", () => {
    expect(parseArgs(["a.json", "--sample", "blocked"]).ok).toBe(false);
  });

  it("拒绝未知选项与多个文件", () => {
    expect(parseArgs(["--wat"]).ok).toBe(false);
    expect(parseArgs(["a.json", "b.json"]).ok).toBe(false);
  });

  it("--pace 只接受三种节奏", () => {
    expect(parseArgs(["a.json", "--pace", "fast"]).ok).toBe(false);
    const ok = parseArgs(["a.json", "--pace", "relaxed"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.args.pace).toBe("relaxed");
  });

  it("help/version 不要求输入", () => {
    expect(parseArgs(["--help"]).ok).toBe(true);
    expect(parseArgs(["--version"]).ok).toBe(true);
  });
});

describe("exitCodeFor", () => {
  const reportOf = (id: "verified" | "blocked" | "unverified") => {
    const sample = getSample(id);
    if (!sample) throw new Error(`missing sample ${id}`);
    return verifyDocument(sample.document);
  };

  it("阻断 → 1；通过 → 0", () => {
    expect(exitCodeFor(reportOf("blocked"), false)).toBe(1);
    expect(exitCodeFor(reportOf("verified"), false)).toBe(0);
  });

  it("unverified 默认通过，--strict 下失败", () => {
    expect(exitCodeFor(reportOf("unverified"), false)).toBe(0);
    expect(exitCodeFor(reportOf("unverified"), true)).toBe(1);
  });
});

describe("formatReport", () => {
  it("color=false 时不含 ANSI 转义，且包含关键段落", () => {
    const sample = getSample("blocked");
    if (!sample) throw new Error("missing sample");
    const report = verifyDocument(sample.document);
    report.credential = credentialOf(sample.document);
    const text = formatReport(report, { color: false });

    expect(text).not.toContain("\x1b[");
    expect(text).toContain("结构自洽性");
    expect(text).toContain("事实核验");
    expect(text).toContain("TC-C102"); // 时间重叠必须被抓到
    expect(text).toContain("凭据  tc_");
    expect(text).toContain("总评");
  });

  it("color=true 时给阻断行上色", () => {
    const sample = getSample("blocked");
    if (!sample) throw new Error("missing sample");
    const text = formatReport(verifyDocument(sample.document), { color: true });
    expect(text).toContain("\x1b[31m"); // red for blocking
  });
});

describe("run（IO 注入，不起进程）", () => {
  it("--sample verified → 退出码 0，输出含凭据", async () => {
    const { io, out } = makeIO();
    const code = await run(["--sample", "verified"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("tc_");
  });

  it("--sample blocked → 退出码 1", async () => {
    const { io } = makeIO();
    expect(await run(["--sample", "blocked"], io)).toBe(1);
  });

  it("确定性：同一示例两次运行的凭据 ID 必须一致", async () => {
    const a = makeIO();
    const b = makeIO();
    await run(["--sample", "verified", "--json"], a.io);
    await run(["--sample", "verified", "--json"], b.io);
    const idA = JSON.parse(a.out.join("")).report.credential.id;
    const idB = JSON.parse(b.out.join("")).report.credential.id;
    expect(idA).toBe(idB);
  });

  it("stdin 读入 + --json 输出可解析", async () => {
    const sample = getSample("verified");
    if (!sample) throw new Error("missing sample");
    const { io, out } = makeIO(JSON.stringify(sample.document));
    const code = await run(["-", "--json"], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.report.verdict.overall).toBe("ok");
  });

  it("--fix 输出修复动作与前后两张凭据", async () => {
    const { io, out } = makeIO();
    await run(["--sample", "blocked", "--fix"], io);
    const text = out.join("\n");
    expect(text).toContain("确定性修复");
    expect(text).toContain("修复前  tc_");
    expect(text).toContain("修复后  tc_");
  });

  it("非法 JSON / 非法文档 / 不存在示例 → 退出码 2", async () => {
    const bad1 = makeIO("not json");
    expect(await run(["-"], bad1.io)).toBe(2);

    const bad2 = makeIO(JSON.stringify({ bad: true }));
    expect(await run(["-"], bad2.io)).toBe(2);
    expect(bad2.err.join("\n")).toContain("specVersion");

    const bad3 = makeIO();
    expect(await run(["--sample", "nope"], bad3.io)).toBe(2);
  });

  it("NO_COLOR 环境变量优先于 TTY", async () => {
    const { io, out } = makeIO();
    io.isTTY = true;
    io.env = { NO_COLOR: "1" };
    await run(["--sample", "verified"], io);
    expect(out.join("\n")).not.toContain("\x1b[");
  });
});
