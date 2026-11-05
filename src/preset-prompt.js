// Local standalone system-prompt validation; no preset installation or YAML rewriting.
export const PRESET_PROMPT_MAX_BYTES = 128 * 1024;

// 安全基线段落：缺失说明 AI 的权限边界可能被削弱，保存时警告（不阻断，管理员有最终决定权）。
export const PRESET_REQUIRED_MARKERS = ['【二代仿真模式 —— 安全规则', '【二代仿真模式 —— 工具协议'];

export const PRESET_BLOCKING_SUBSTRINGS = [
  '你没有本地工具',
  '群友没有管理权限',
  'API 令牌',
  '角色由桥接注入',
  '不会自动发送到 QQ',
];
export const PRESET_MIN_BODY_CHARS = 500;

/** 硬性校验：返回阻止保存的原因列表（空数组=可保存）。 */
export function presetPromptBlockers(content) {
  const text = String(content ?? '');
  const blockers = [];
  if (!text.trim()) {
    blockers.push('仿真提示词不能为空');
    return blockers;
  }
  for (const needle of PRESET_BLOCKING_SUBSTRINGS) {
    if (!text.includes(needle)) {
      blockers.push(`缺少安全不变量「${needle}」：删除它会让 AI 的权限边界失效`);
    }
  }
  if (text.trim().length < PRESET_MIN_BODY_CHARS) {
    blockers.push(`正文过短（${text.trim().length} 字符 < ${PRESET_MIN_BODY_CHARS}）：疑似内容被误删`);
  }
  return blockers;
}

export function presetPromptWarnings(content) {
  const text = String(content ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('内容为空');
  for (const marker of PRESET_REQUIRED_MARKERS) {
    if (!text.includes(marker)) warnings.push(`缺少「${marker}…】段落：AI 的权限与工具边界可能被削弱`);
  }
  return warnings;
}
