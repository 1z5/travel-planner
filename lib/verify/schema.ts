// ============================================================
// Trip Check v0.1 的 JSON Schema（公开契约）
//
// 为什么要手写一份：开放标准的第一交付物是**机器可校验的契约**，不是文档。
// 第三方（OTA/agent/个人开发者）要能在提交前自己校验文档格式，不依赖我们的
// 服务端实现。这里刻意不引入 schema 生成依赖（zod→json-schema 会多一条
// 工具链），手写 + 单测比对字段，保证契约可独立分发。
//
// 与 validate.ts（服务端 zod 校验）的分工：
// - JSON Schema：对外发布的契约（宽松：允许扩展字段，additionalProperties=true）；
// - zod：服务端实际解析（归一化 + 限额 + 中文错误信息），两者字段必须同步。
// ============================================================

/** JSON Schema（draft 2020-12）。供 GET /api/verify/schema 直接返回 */
export const TRIP_CHECK_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:trip-check:document:0.1",
  title: "Trip Check Itinerary Document v0.1",
  description:
    "行程可执行性核验的开放文档格式。结构自洽性（时间轴/节奏/预算）只靠文档即可判定；事实核验（地点/营业时间/路程）取决于文档声明的 provenance 与 verification 三态。",
  type: "object",
  required: ["specVersion", "days"],
  additionalProperties: true,
  properties: {
    specVersion: {
      type: "string",
      const: "trip-check/0.1",
      description: "规范版本。不兼容变更升 minor。",
    },
    id: { type: "string", maxLength: 120, description: "外部标识（可选）" },
    city: { type: "string", maxLength: 40, description: "目的地城市（可选）" },
    budgetCny: { type: "number", minimum: 0, description: "人均总预算（人民币元）" },
    provenance: {
      type: "object",
      description: "文档级事实来源；点位/路段未单独声明时继承",
      additionalProperties: false,
      properties: {
        poi: { $ref: "#/$defs/provenanceEntry" },
        routes: { $ref: "#/$defs/provenanceEntry" },
        hours: { $ref: "#/$defs/provenanceEntry" },
      },
    },
    days: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: { $ref: "#/$defs/day" },
    },
  },
  $defs: {
    source: {
      type: "string",
      enum: ["amap", "google_places", "osm", "manual", "mock", "other"],
      description: "事实来源",
    },
    factState: {
      type: "string",
      enum: ["hit", "miss", "error", "not_checked"],
      description:
        "事实三态：hit=查到；miss=查询成功但来源没有；error=查询失败（不知道，不是不存在）；not_checked=未查",
    },
    provenanceEntry: {
      type: "object",
      required: ["source"],
      additionalProperties: true,
      properties: {
        source: { $ref: "#/$defs/source" },
        checkedAt: { type: "string", format: "date-time", description: "核验时间（ISO 8601）" },
      },
    },
    verification: {
      type: "object",
      additionalProperties: true,
      properties: {
        source: { $ref: "#/$defs/source" },
        existence: { $ref: "#/$defs/factState" },
        hours: { $ref: "#/$defs/factState" },
        checkedAt: { type: "string", format: "date-time" },
      },
    },
    hours: {
      type: "object",
      additionalProperties: true,
      properties: {
        openTime: { type: "string", maxLength: 500, description: "营业时间原文（简版）" },
        openTime2: {
          type: "string",
          maxLength: 2000,
          description: "营业时间原文（含闭馆规则/季节/最晚进入）",
        },
        temporarilyClosed: { type: "boolean" },
      },
    },
    spot: {
      type: "object",
      required: ["name", "time"],
      additionalProperties: true,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        time: {
          type: "string",
          description: '"HH:MM-HH:MM" 同日时段；跨零点/零长视为非法',
        },
        type: {
          type: "string",
          enum: ["sight", "food", "hotel", "transport", "shopping", "activity"],
        },
        durationMin: { type: "number", exclusiveMinimum: 0, description: "停留分钟数" },
        costCny: { type: "number", minimum: 0, description: "人均花费（元）" },
        area: { type: "string", maxLength: 120, description: "所在商圈/区域" },
        location: { type: "string", maxLength: 80, description: '"经度,纬度"' },
        hours: { $ref: "#/$defs/hours" },
        verification: { $ref: "#/$defs/verification" },
      },
    },
    leg: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: true,
      properties: {
        from: { type: "string", maxLength: 120 },
        to: { type: "string", maxLength: 120 },
        mode: {
          type: "string",
          enum: ["walking", "bicycling", "driving", "transit", "auto"],
        },
        durationMin: { type: "number", minimum: 0, description: "路段耗时（分钟）" },
        distanceM: { type: "number", minimum: 0 },
        source: { $ref: "#/$defs/source" },
        state: { $ref: "#/$defs/factState" },
      },
    },
    day: {
      type: "object",
      required: ["day", "spots"],
      additionalProperties: true,
      properties: {
        day: { type: "integer", minimum: 1, maximum: 365 },
        date: {
          type: "string",
          format: "date",
          description: "YYYY-MM-DD；缺失时营业时间判定跳过（不猜周几）",
        },
        city: { type: "string", maxLength: 40 },
        spots: {
          type: "array",
          maxItems: 40,
          items: { $ref: "#/$defs/spot" },
        },
        legs: {
          type: "array",
          maxItems: 40,
          description: "相邻点位之间的路段；缺省 = 无法判断通勤是否可行",
          items: { $ref: "#/$defs/leg" },
        },
      },
    },
  },
};

/** 规范版本号导出（避免第三方从 schema 文本里硬解析） */
export const TRIP_CHECK_SCHEMA_VERSION = "0.1";
