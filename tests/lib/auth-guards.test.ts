import { describe, expect, it, vi } from "vitest";
import {
  DEV_SESSION_SECRET,
  hasUsableSessionSecret,
  isDevAuthExplicitlyAllowed,
  isProductionAuthMisconfigured,
  isProductionEnv,
  isProductionSessionMisconfigured,
  resolveAuthProviderId,
  type GuardEnv,
} from "@/lib/auth/guards";
import { getAuthProvider } from "@/lib/auth/providers";
import { createSession, readSession, SESSION_COOKIE } from "@/lib/auth/session";

// 生产配置守卫：这一层的意义是「默认配置上线 = 任意手机号可登录」必须
// fail-closed。测试全部用 env 对象注入（不改进程级 process.env），因为
// vitest 同进程共享 env，改 NODE_ENV 忘了还原会污染其他用例——而且
// next dev 的 e2e 依赖 NODE_ENV=development 下的旧行为，不能被悄悄改掉。

const STRONG_SECRET = "a".repeat(64);

function prod(over: GuardEnv = {}): GuardEnv {
  return { NODE_ENV: "production", AUTH_PROVIDER: "sms", SESSION_SECRET: STRONG_SECRET, ...over };
}

describe("guards：环境判定", () => {
  it("只有严格等于 production 才算生产（e2e 用 next dev）", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: " development " })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });

  it("AUTH_PROVIDER 归一化：缺省/拼错回落 none，空白被裁掉", () => {
    expect(resolveAuthProviderId({})).toBe("none");
    expect(resolveAuthProviderId({ AUTH_PROVIDER: " sms " })).toBe("sms");
    expect(resolveAuthProviderId({ AUTH_PROVIDER: "wechat" })).toBe("wechat");
    // 拼错 = 配置没生效：必须当作 none，才能被生产守卫拦住
    expect(resolveAuthProviderId({ AUTH_PROVIDER: "SMS" })).toBe("none");
    expect(resolveAuthProviderId({ AUTH_PROVIDER: "null" })).toBe("none");
  });

  it("SESSION_SECRET 可用性：缺失或仍是公开默认值都不算可用", () => {
    expect(hasUsableSessionSecret({})).toBe(false);
    expect(hasUsableSessionSecret({ SESSION_SECRET: "" })).toBe(false);
    expect(hasUsableSessionSecret({ SESSION_SECRET: DEV_SESSION_SECRET })).toBe(false);
    expect(hasUsableSessionSecret({ SESSION_SECRET: STRONG_SECRET })).toBe(true);
  });

  it("ALLOW_DEV_AUTH 只认显式 1", () => {
    expect(isDevAuthExplicitlyAllowed({ ALLOW_DEV_AUTH: "1" })).toBe(true);
    expect(isDevAuthExplicitlyAllowed({ ALLOW_DEV_AUTH: "true" })).toBe(false);
    expect(isDevAuthExplicitlyAllowed({})).toBe(false);
  });
});

describe("guards：生产身份体系误配判定", () => {
  it("生产 + AUTH_PROVIDER=none → 误配", () => {
    expect(
      isProductionAuthMisconfigured({ NODE_ENV: "production", SESSION_SECRET: STRONG_SECRET }),
    ).toBe(true);
  });

  it("生产 + 缺 SESSION_SECRET → 误配", () => {
    expect(isProductionAuthMisconfigured(prod({ SESSION_SECRET: undefined }))).toBe(true);
  });

  it("生产 + SESSION_SECRET 仍是开发默认值 → 误配", () => {
    expect(isProductionAuthMisconfigured(prod({ SESSION_SECRET: DEV_SESSION_SECRET }))).toBe(true);
  });

  it("生产正常配置（sms/wechat + 强 secret）→ 不误配", () => {
    expect(isProductionAuthMisconfigured(prod())).toBe(false);
    expect(isProductionAuthMisconfigured(prod({ AUTH_PROVIDER: "wechat" }))).toBe(false);
  });

  it("ALLOW_DEV_AUTH=1 是显式知情后的逃生口：仍要求强 secret", () => {
    // 预发/内部演示可以用 none-provider，但必须同时给强 secret 且显式开关
    expect(
      isProductionAuthMisconfigured(
        prod({ AUTH_PROVIDER: "none", ALLOW_DEV_AUTH: "1", SESSION_SECRET: STRONG_SECRET }),
      ),
    ).toBe(false);
    // 弱 secret 永远不允许：开关只放行 provider，不放行签名密钥
    expect(
      isProductionAuthMisconfigured(
        prod({ AUTH_PROVIDER: "none", ALLOW_DEV_AUTH: "1", SESSION_SECRET: DEV_SESSION_SECRET }),
      ),
    ).toBe(true);
  });

  it("非生产环境恒不误配（e2e phase C/D/E 的 next dev 行为不变）", () => {
    expect(isProductionAuthMisconfigured({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionAuthMisconfigured({ NODE_ENV: "test", AUTH_PROVIDER: "none" })).toBe(false);
    expect(isProductionAuthMisconfigured({})).toBe(false);
  });

  it("session 层误配只看生产 + secret（与 provider 是否启用无关）", () => {
    expect(isProductionSessionMisconfigured({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionSessionMisconfigured(prod())).toBe(false);
    expect(isProductionSessionMisconfigured({ NODE_ENV: "development" })).toBe(false);
  });
});

describe("providers：生产误配 fail-closed", () => {
  it("生产 + none/弱 secret → DisabledProvider，绝不回落 DevProvider", async () => {
    const provider = getAuthProvider({
      NODE_ENV: "production",
      AUTH_PROVIDER: "none",
      SESSION_SECRET: DEV_SESSION_SECRET,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const sent = await provider.sendCode("13800138000");
      expect(sent).toEqual({ ok: false, error: "登录未启用" });
      // 关键反证：固定开发码 123456 在生产误配时必须无效
      expect(await provider.verifyCode("13800138000", "123456")).toBe(false);
      // 也不能打「验证码是 123456」的开发日志（会把测试码泄漏到生产日志）
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("生产 + sms/wechat + 强 secret → 返回真实 provider", () => {
    expect(getAuthProvider(prod()).id).toBe("sms");
    expect(getAuthProvider(prod({ AUTH_PROVIDER: "wechat" })).id).toBe("wechat");
  });

  it("开发环境（next dev）保持原行为：none → DevProvider 固定码 123456", async () => {
    const provider = getAuthProvider({ NODE_ENV: "development" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(provider.id).toBe("none");
      expect(await provider.sendCode("13800138000")).toEqual({ ok: true });
      expect(await provider.verifyCode("13800138000", "123456")).toBe(true);
      expect(await provider.verifyCode("13800138000", "000000")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("test 环境同样走 DevProvider（现有单测/本地脚本不受生产守卫影响）", async () => {
    const provider = getAuthProvider({ NODE_ENV: "test", AUTH_PROVIDER: "none" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await provider.verifyCode("13800138000", "123456")).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe("session：生产 fail-closed", () => {
  // 注意顺序：这条必须是本文件里第一个「生产弱 secret」用例——日志是一次性
  // 模块状态（生产弱密钥只记一次 error，避免刷爆日志），先跑才能断言恰好一条。
  it("首次遇到弱 secret 记一条 error，后续请求不再重复刷日志", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      readSession(`tp_session=a.b`, { NODE_ENV: "production" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("SESSION_SECRET");
      readSession(`tp_session=a.b`, { NODE_ENV: "production" });
      readSession(`tp_session=a.b`, { NODE_ENV: "production" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("生产弱 secret：createSession 抛清晰错误（不签出可伪造的 token）", () => {
    expect(() => createSession("13800138000", { NODE_ENV: "production" })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() =>
      createSession("13800138000", {
        NODE_ENV: "production",
        SESSION_SECRET: DEV_SESSION_SECRET,
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("生产弱 secret：即便拿着默认密钥签出的合法 token 也一律当作未登录", () => {
    const { token } = createSession("13800138000", { NODE_ENV: "development" });
    expect(readSession(`${SESSION_COOKIE}=${token}`, { NODE_ENV: "production" })).toBe(null);
  });

  it("开发环境保持原行为：默认密钥可正常签发/校验（e2e 登录链路依赖）", () => {
    const env: GuardEnv = { NODE_ENV: "development" };
    const created = createSession("13800138000", env);
    const session = readSession(`${SESSION_COOKIE}=${created.token}`, env);
    expect(session?.p).toBe("13800138000");
  });

  it("生产强 secret：正常签发与校验", () => {
    const env = prod();
    const created = createSession("13800138000", env);
    expect(readSession(`${SESSION_COOKIE}=${created.token}`, env)?.p).toBe("13800138000");
  });

  it("篡改签名 / 无 cookie 一律 null", () => {
    const env = prod();
    const { token } = createSession("13800138000", env);
    expect(readSession(`${SESSION_COOKIE}=${token}x`, env)).toBe(null);
    expect(readSession(null, env)).toBe(null);
    expect(readSession("other=1", env)).toBe(null);
  });
});
