/**
 * Finalize Result extension for Pi Coding Agent.
 * Result summarization and formatting.
 *
 * 将顶层标准 JSON 对象原样写入 <cwd>/<aiTaskId>.result.json，并清除
 * <cwd>/<aiTaskId>.status 标记。它不校验、补全或改写业务 schema；schema
 * 校验由调用 skill 或其专属消费者负责。为兼容模型将完整 JSON 当字符串传参
 * 的情况，工具会安全解析其中的 JSON 对象；普通文本、命令输出、数组及标量
 * 仍会被拒绝。terminate:true 建议本批后停（协作，非强制）。
 *
 * 注意：扩展经 jiti 运行时加载，不能用 @/ 别名，本文件须自包含。
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const RESULT_SUFFIX = ".result.json";
const STATUS_SUFFIX = ".status";

type JsonSerialization =
  | { ok: true; json: string }
  | { ok: false; error: string };

type NormalizedResult =
  | { ok: true; value: Record<string, unknown>; normalizedFromJsonString: boolean }
  | { ok: false; error: string };

interface FinalizeParams {
  result: unknown;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Require a structured result while recovering the common tool-call shape where
 * the model passes JSON.stringify(result) as a string. The recovered value is
 * written as the object, never as a double-encoded JSON string.
 */
export function normalizeResultObject(value: unknown): NormalizedResult {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlainJsonObject(parsed)) {
        return { ok: true, value: parsed, normalizedFromJsonString: true };
      }
      if (Array.isArray(parsed)) {
        return { ok: false, error: "result JSON 字符串解析后是数组；最终结果必须是顶层 JSON 对象" };
      }
      return { ok: false, error: "result JSON 字符串解析后不是对象；最终结果必须是顶层 JSON 对象" };
    } catch {
      return {
        ok: false,
        error: "result 必须是顶层 JSON 对象；普通文本、命令或 PowerShell/Bash 输出不能作为最终结果",
      };
    }
  }

  if (isPlainJsonObject(value)) {
    return { ok: true, value, normalizedFromJsonString: false };
  }
  if (Array.isArray(value)) {
    return { ok: false, error: "result 必须是顶层 JSON 对象，不能是数组" };
  }
  if (value === null) {
    return { ok: false, error: "result 必须是顶层 JSON 对象，不能是 null" };
  }
  return { ok: false, error: "result 必须是顶层 JSON 对象，不能是 JSON 基础类型" };
}

function findInvalidJsonValue(
  value: unknown,
  path = "$",
  ancestors = new Set<object>()
): string | null {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path} must be a finite JSON number`;
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      return `${path} has unsupported JSON type ${typeof value}`;
    case "object": {
      if (ancestors.has(value)) return `${path} contains a circular reference`;
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            const error = findInvalidJsonValue(value[index], `${path}[${index}]`, ancestors);
            if (error) return error;
          }
          return null;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          return `${path} must be a plain JSON object`;
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          return `${path} must not contain symbol properties`;
        }
        for (const [key, nestedValue] of Object.entries(value)) {
          const error = findInvalidJsonValue(nestedValue, `${path}.${key}`, ancestors);
          if (error) return error;
        }
        return null;
      } finally {
        ancestors.delete(value);
      }
    }
  }

  return `${path} has an unsupported JSON value`;
}

/** Return a pretty-printed JSON document or a precise serialization error. */
export function serializeJsonResult(value: unknown): JsonSerialization {
  try {
    const validationError = findInvalidJsonValue(value);
    if (validationError) return { ok: false, error: validationError };

    const json = JSON.stringify(value, null, 2);
    if (typeof json !== "string") {
      return { ok: false, error: "result could not be serialized as JSON" };
    }
    // Keep the write boundary strict even if the validator is changed later.
    JSON.parse(json);
    return { ok: true, json };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Preserve the existing asset-task failure convention without imposing it on
 * other result contracts. Any persisted object without task.status="failed"
 * is a successful finalization from this tool's perspective.
 */
function finalizedStatus(result: Record<string, unknown>): "succeeded" | "failed" {
  const task = result.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return "succeeded";
  return (task as Record<string, unknown>).status === "failed" ? "failed" : "succeeded";
}

export default function registerFinalizeResult(pi: ExtensionAPI) {
  pi.registerTool({
    name: "finalize_result",
    label: "Finalize Result",
    description:
      "通用 JSON 对象定稿：将顶层标准 JSON 对象原样写入 <cwd>/<aiTaskId>.result.json，清除状态标记并结束本轮。工具不校验、补全或改写业务 schema；若模型将完整对象作为 JSON 字符串传入，会先解析后落盘，普通文本或命令输出会被拒绝。",
    parameters: Type.Object({
      result: Type.Any({ description: "要落盘的顶层标准 JSON 对象。兼容 JSON.stringify(...) 产生且可解析为对象的字符串；不可传普通文本、命令输出、数组、null、undefined、NaN、Infinity、BigInt、函数、Symbol 或循环引用" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as FinalizeParams;
      const cwd = ctx?.cwd;
      if (!cwd) {
        return {
          content: [{ type: "text", text: "缺少 cwd，无法定稿" }],
          details: { error: true, message: "missing cwd" },
          isError: true,
        };
      }

      // sessionId 即 aiTaskId；sessionManager 在 ExtensionContext 上只读暴露
      const sm = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
      const aiTaskId = typeof sm?.getSessionId === "function" ? sm.getSessionId() : "";
      if (!aiTaskId) {
        return {
          content: [{ type: "text", text: "无法解析当前 aiTaskId，无法定稿" }],
          details: { error: true, message: "missing sessionId" },
          isError: true,
        };
      }

      const normalized = normalizeResultObject(p.result);
      if (!normalized.ok) {
        return {
          content: [{ type: "text", text: `结果未定稿：${normalized.error}` }],
          details: { error: true, message: "result must be a JSON object", validationError: normalized.error, aiTaskId },
          isError: true,
        };
      }

      const serialized = serializeJsonResult(normalized.value);
      if (!serialized.ok) {
        return {
          content: [{ type: "text", text: `结果不是可落盘的标准 JSON：${serialized.error}` }],
          details: { error: true, message: "invalid JSON result", validationError: serialized.error, aiTaskId },
          isError: true,
        };
      }

      const resultPath = join(cwd, `${aiTaskId}${RESULT_SUFFIX}`);
      const statusPath = join(cwd, `${aiTaskId}${STATUS_SUFFIX}`);
      try {
        writeFileSync(resultPath, serialized.json, "utf8");
      } catch (error) {
        return {
          content: [{ type: "text", text: `写结果文件失败: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true, message: "write result failed", aiTaskId },
          isError: true,
        };
      }

      // 清状态标记（不存在则忽略）
      try {
        if (existsSync(statusPath)) unlinkSync(statusPath);
      } catch {
        /* ignore */
      }

      const status = finalizedStatus(normalized.value);
      return {
        content: [{ type: "text", text: normalized.normalizedFromJsonString ? "结果已解析 JSON 字符串并定稿落盘" : "结果已定稿并原样落盘" }],
        details: { aiTaskId, status, normalizedFromJsonString: normalized.normalizedFromJsonString || undefined },
        terminate: true,
      };
    },
  });
}
