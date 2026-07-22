import { createHash } from "node:crypto";

/** 为会话精确授权生成不可逆指纹，避免把命令和路径原文重复写入会话元数据。 */
export function fingerprintPermissionValue(
  value: string,
  caseSensitive: boolean,
): string {
  const comparable = caseSensitive
    ? value
    : value.toLocaleLowerCase("en-US");

  return createHash("sha256").update(comparable, "utf8").digest("hex");
}
