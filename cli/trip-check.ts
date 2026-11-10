// ============================================================
// Trip Check CLI 入口（IO 层；格式与参数逻辑在 report-format.ts / args.ts）
//
// 这个 CLI 的存在理由（详见 ADR-017）：开放标准的第一承诺是「任何人都能独立
// 复算同一结论」，但此前引擎只藏在 HTTP API 后面——要复算就得先 clone、装依赖、
// 起 Next 服务。CLI 把门槛降到「一个命令、零 key、零网络」。
//
// 刻意不做的事：
// - 不调 LLM 做文本抽取（那是 /api/verify/extract 的职责，需要 key 且不确定）；
//   CLI 只接受已成形的 Trip Check v0.1 JSON，判定与修复完全确定性。
// - 不联网、不写文件：同一份文档在任何机器上都必须算出同一个凭据 ID。
// ============================================================

import { readFile } from "node:fs/promises";
import { credentialOf } from "../lib/verify/credential";
import { verifyDocument } from "../lib/verify/engine";
import { repairDocument } from "../lib/verify/repair";
import { getSample } from "../lib/verify/samples";
import {
  TRIP_CHECK_ENGINE_NAME,
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckDocument,
  type TripCheckOptions,
} from "../lib/verify/types";
import { parseTripCheckDocument } from "../lib/verify/validate";
import { CLI_USAGE, parseArgs, type CliArgs } from "./args";
import { exitCodeFor, formatRepair, formatReport } from "./report-format";

/** 可注入的 IO，让 vitest 不起进程也能测完整链路 */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** 读取 stdin 全部内容（仅在输入为 "-" 时调用） */
  readStdin: () => Promise<string>;
  /** 是否 TTY（决定颜色默认值） */
  isTTY: boolean;
  /** 用宽松的 Record 而不是 NodeJS.ProcessEnv：测试注入 {} 不该被类型拦住 */
  env: Record<string, string | undefined>;
}

function defaultIO(): CliIO {
  return {
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
    readStdin: () =>
      new Promise((resolvePromise, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c: Buffer) => chunks.push(c));
        process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
      }),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  };
}

/** 读入原始 JSON 文本：内置示例 / 文件 / stdin 三条路径 */
async function loadRawDocument(args: CliArgs, io: CliIO): Promise<unknown> {
  if (args.sample) {
    const sample = getSample(args.sample);
    if (!sample) {
      throw new CliInputError(
        `没有名为「${args.sample}」的示例（可选：verified / blocked / unverified）`,
      );
    }
    return sample.document;
  }
  const text = args.file === "-" ? await io.readStdin() : await readFile(args.file!, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new CliInputError("输入不是合法 JSON。CLI 只接受 Trip Check v0.1 文档，不做文本抽取。");
  }
}

/** 输入类错误（用法/文件/校验），统一退出码 2；与「判定出阻断」（1）区分 */
class CliInputError extends Error {}

export async function run(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr(`错误：${parsed.error}`);
    io.stderr(CLI_USAGE);
    return 2;
  }
  const args = parsed.args;

  if (args.help) {
    io.stdout(CLI_USAGE);
    return 0;
  }
  if (args.version) {
    io.stdout(
      `${TRIP_CHECK_ENGINE_NAME} ${TRIP_CHECK_ENGINE_VERSION} · 规则集 ${TRIP_CHECK_RULESET_VERSION} · 规范 ${TRIP_CHECK_SPEC_VERSION}`,
    );
    return 0;
  }

  // 颜色三要素：显式 --no-color > NO_COLOR 环境变量 > TTY 检测
  const color = args.color && !io.env.NO_COLOR && io.isTTY;
  const fmt = { color };

  let raw: unknown;
  try {
    raw = await loadRawDocument(args, io);
  } catch (e) {
    if (e instanceof CliInputError) {
      io.stderr(`错误：${e.message}`);
      return 2;
    }
    const msg = e instanceof Error ? e.message : String(e);
    io.stderr(`错误：读不到输入（${msg}）`);
    return 2;
  }

  const docResult = parseTripCheckDocument(raw);
  if (!docResult.ok) {
    io.stderr("文档不符合 Trip Check v0.1 格式：");
    for (const err of docResult.errors.slice(0, 10)) {
      io.stderr(`  · ${err.path}: ${err.message}`);
    }
    if (docResult.errors.length > 10) {
      io.stderr(`  … 另有 ${docResult.errors.length - 10} 处`);
    }
    return 2;
  }
  const document: TripCheckDocument = docResult.value;
  const options: TripCheckOptions = args.pace ? { pace: args.pace } : {};

  if (args.fix) {
    const result = repairDocument(document, options);
    // 前后两张凭据：改了什么、风险降了多少，都要可对账（与 /api/verify/repair 同口径）
    result.before.credential = credentialOf(document, options);
    result.after.credential = credentialOf(result.document, options);
    if (args.json) {
      io.stdout(JSON.stringify({ repair: result }, null, 2));
    } else {
      io.stdout(formatRepair(result, fmt));
    }
    return exitCodeFor(result.after, args.strict);
  }

  const report = verifyDocument(document, options);
  report.credential = credentialOf(document, options);

  if (args.json) {
    io.stdout(JSON.stringify({ report }, null, 2));
  } else {
    io.stdout(formatReport(report, fmt));
  }
  return exitCodeFor(report, args.strict);
}
