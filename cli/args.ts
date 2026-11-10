// ============================================================
// Trip Check CLI 参数解析（纯函数，无 IO）
//
// 为什么手写而不是引依赖：这个 CLI 的卖点之一是「零配置、离线、单文件可跑」，
// 为一个 < 10 个 flag 的工具引入 arg 解析库，与这个卖点自相矛盾。
// ============================================================

export interface CliArgs {
  /** 文档路径；"-" 表示从 stdin 读 */
  file?: string;
  /** 内置示例 id（verified / blocked / unverified） */
  sample?: string;
  /** 机读 JSON 输出（给 CI / agent 用） */
  json: boolean;
  /** 确定性修复：输出修复动作 + 前后两张凭据 */
  fix: boolean;
  /** 严格口径：warnings / unverified 也让退出码为 1 */
  strict: boolean;
  /** 判定口径：行程节奏（与引擎 TripCheckOptions.pace 一致） */
  pace?: "relaxed" | "balanced" | "packed";
  /** 用户显式 --no-color（NO_COLOR / 非 TTY 由入口折算） */
  color: boolean;
  help: boolean;
  version: boolean;
}

export type ParseArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string };

const PACES = new Set(["relaxed", "balanced", "packed"]);

export const CLI_USAGE = `用法：
  trip-check <行程.json>        核验一份 Trip Check v0.1 文档
  trip-check -                  从 stdin 读文档
  trip-check --sample blocked   跑内置示例（verified / blocked / unverified）

选项：
  --fix                 确定性修复：只做机械修复（顺延时间/删同天重复），给前后两张凭据
  --json                机读 JSON 输出（含报告与凭据）
  --strict              严格口径：提醒/未核验也让退出码为 1（默认只有阻断才失败）
  --pace <节奏>         relaxed | balanced(默认) | packed
  --no-color            关闭颜色（NO_COLOR 环境变量与非 TTY 也会自动关）
  --help                显示帮助
  --version             显示引擎/规则集/规范版本

退出码：0 通过 · 1 有阻断问题（--strict 下含提醒/未核验） · 2 输入非法`;

export function parseArgs(argv: string[]): ParseArgsResult {
  const args: CliArgs = {
    json: false,
    fix: false,
    strict: false,
    color: true,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--fix":
        args.fix = true;
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--no-color":
        args.color = false;
        break;
      case "--sample": {
        const id = argv[i + 1];
        if (!id || id.startsWith("-")) return { ok: false, error: "--sample 需要一个示例 id" };
        args.sample = id;
        i += 1;
        break;
      }
      case "--pace": {
        const pace = argv[i + 1];
        if (!pace || !PACES.has(pace)) {
          return { ok: false, error: "--pace 只接受 relaxed / balanced / packed" };
        }
        args.pace = pace as CliArgs["pace"];
        i += 1;
        break;
      }
      default:
        if (a.startsWith("--")) return { ok: false, error: `未知选项：${a}` };
        if (args.file !== undefined) return { ok: false, error: "只能提供一个输入文件" };
        args.file = a;
    }
  }

  if (args.help || args.version) return { ok: true, args };
  if (args.file !== undefined && args.sample !== undefined) {
    return { ok: false, error: "文件与 --sample 只能二选一" };
  }
  if (args.file === undefined && args.sample === undefined) {
    return { ok: false, error: "需要提供文档路径、-（stdin）或 --sample <id>" };
  }
  return { ok: true, args };
}
