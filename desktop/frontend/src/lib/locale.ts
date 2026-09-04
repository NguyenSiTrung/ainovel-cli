/**
 * Minimal en/vi/zh locale catalog for desktop frontend chrome strings.
 *
 * Hand-rolled tiny tables (no new deps), mirroring the engine-side i18n
 * catalog shape (`internal/i18n`): the engine remains the normalizer/echo
 * authority for language codes — the frontend sends trim-only values and
 * displays the echoed codes. `currentLanguage` is synced from the
 * engine-reported UI language (`refreshConfig` view.language); unknown or
 * missing codes leave the current locale untouched.
 *
 * `t(key)` reads the current locale with an English fallback; `presentError`
 * and the route chrome resolve through it so switching locales needs no
 * component rewiring beyond subscribing to `currentLanguage`.
 */

import { get, writable, type Writable } from 'svelte/store';

/** Chrome locales the frontend can render (matches LANGUAGE_CHOICES). */
export type SupportedLanguage = 'en' | 'vi' | 'zh';

export const SUPPORTED_LANGUAGES = ['en', 'vi', 'zh'] as const;

/** Every chrome string key; `en` is the complete reference table. */
export type LocaleKey = string;

const en: Record<LocaleKey, string> = {
  'route.overview.label': 'Overview',
  'route.overview.description':
    'Project, progress, runtime state, recovery, budget, usage, recent events, actions.',
  'route.write.label': 'Write',
  'route.write.description':
    'Plan, streamed content, steer, pause, abort, continue, retry, chapter authorization.',
  'route.chapters.label': 'Chapters',
  'route.chapters.description':
    'List, read, edit, save, unsaved-change protection, revision sync, export.',
  'route.artifacts.label': 'Artifacts',
  'route.artifacts.description': 'Outline, characters, facts, world: read-only projections.',
  'route.cocreate.label': 'Co-create',
  'route.cocreate.description': 'Conversation, staged stream, review/edit, resume, cancel.',
  'route.import.label': 'Import',
  'route.import.description': 'Source selection, start/resume/cancel, progress, results.',
  'route.simulation.label': 'Simulation',
  'route.simulation.description':
    'Source selection, start/resume/cancel, profile display, profile import.',
  'route.diagnostics.label': 'Diagnostics',
  'route.diagnostics.description':
    'Findings, runtime errors, sessions, checkpoints, event queue, sanitized export.',
  'route.settings.label': 'Settings',
  'route.settings.description':
    'Providers, models, thinking, languages, budgets, notifications, updates.',
  'route.export.label': 'Export',
  'route.export.description': 'Chapter selection, formats, output destination, results.',
  'error.malformed_json.title': 'Protocol noise',
  'error.malformed_json.description': 'The engine received a line it could not parse.',
  'error.malformed_json.action': 'If this repeats, restart the engine from Diagnostics.',
  'error.invalid_payload.title': 'Invalid request',
  'error.invalid_payload.description': 'A request was rejected because its payload was invalid.',
  'error.invalid_payload.action': '',
  'error.unknown_method.title': 'Unsupported command',
  'error.unknown_method.description':
    'This version of the engine does not implement that command.',
  'error.unknown_method.action': '',
  'error.duplicate_request_id.title': 'Duplicate request',
  'error.duplicate_request_id.description':
    'The same request was sent twice while still in flight.',
  'error.duplicate_request_id.action': '',
  'error.project_unavailable.title': 'No project open',
  'error.project_unavailable.description': 'This action needs an open project.',
  'error.project_unavailable.action': 'Open or create a project first.',
  'error.host_busy.title': 'Engine busy',
  'error.host_busy.description': 'Another exclusive operation is already active.',
  'error.host_busy.action': 'Wait for it to finish, or abort it first.',
  'error.operation_failed.title': 'Operation failed',
  'error.operation_failed.description': 'The engine attempted the operation and it failed.',
  'error.operation_failed.action': '',
  'error.cancelled.title': 'Cancelled',
  'error.cancelled.description': 'The operation was cancelled before completing.',
  'error.cancelled.action': '',
  'error.internal_error.title': 'Engine error',
  'error.internal_error.description':
    'The engine reported an internal failure; its state may be inconsistent.',
  'error.internal_error.action': 'Check Diagnostics, then consider restarting the engine.',
  'error.engine_unavailable.title': 'Engine unavailable',
  'error.engine_unavailable.description':
    'The engine is not running or died while handling the request.',
  'error.engine_unavailable.action': 'Wait for the automatic restart, or start the engine again.',
  'error.request_timeout.title': 'Request timed out',
  'error.request_timeout.description': 'The engine did not answer in time.',
  'error.request_timeout.action': '',
  'error.sidecar_error.title': 'Engine process error',
  'error.sidecar_error.description':
    'The engine process could not be started or supervised.',
  'error.sidecar_error.action': 'Check that the engine binary is available, then retry.',
  'error.invalid_path.title': 'Invalid path',
  'error.invalid_path.description': 'The path was rejected by native validation.',
  'error.invalid_path.action': 'Pick an absolute path without traversal segments.',
  'error.unknown.title': 'Unexpected error',
  'error.unknown.description': 'An unrecognized error code arrived from the engine.',
  'error.unknown.action': '',
  'settings.languages.title': 'Languages',
  'settings.languages.interfaceLabel': 'interface language',
  'settings.languages.setInterface': 'Set interface language',
  'settings.languages.storyLabel': 'story language',
  'settings.languages.setStory': 'Set story language',
  'settings.languages.applying': 'Applying…',
  'settings.languages.current': 'Current',
  'settings.languages.default': 'Default',
  'settings.languages.hint':
    'The engine normalizes codes (en / vi / zh) and echoes the applied value. Interface applies now; story applies on next project open.',
  'settings.empty.hint':
    'Configuration is project-scoped — open or create a project from the Overview screen.',
  'common.noProject.title': 'No project open',
};

const vi: Record<LocaleKey, string> = {
  'route.overview.label': 'Tổng quan',
  'route.overview.description':
    'Dự án, tiến độ, trạng thái runtime, khôi phục, ngân sách, mức sử dụng, sự kiện gần đây, hành động.',
  'route.write.label': 'Viết',
  'route.write.description':
    'Lập dàn ý, nội dung trực tiếp, điều hướng, tạm dừng, hủy bỏ, tiếp tục, thử lại, duyệt chương.',
  'route.chapters.label': 'Chương',
  'route.chapters.description':
    'Liệt kê, đọc, sửa, lưu, bảo vệ thay đổi chưa lưu, đồng bộ bản thảo, xuất bản.',
  'route.artifacts.label': 'Tư liệu',
  'route.artifacts.description': 'Dàn ý, nhân vật, sự kiện, thế giới: dữ liệu chỉ đọc.',
  'route.cocreate.label': 'Đồng sáng tạo',
  'route.cocreate.description': 'Hội thoại, luồng dàn ý, xem lại/sửa, tiếp tục, hủy bỏ.',
  'route.import.label': 'Nhập',
  'route.import.description': 'Chọn nguồn, bắt đầu/tiếp tục/hủy, tiến độ, kết quả.',
  'route.simulation.label': 'Mô phỏng',
  'route.simulation.description':
    'Chọn nguồn, bắt đầu/tiếp tục/hủy, hiển thị hồ sơ, nhập hồ sơ.',
  'route.diagnostics.label': 'Chẩn đoán',
  'route.diagnostics.description':
    'Phát hiện, lỗi runtime, phiên, checkpoint, hàng đợi sự kiện, xuất dữ liệu đã lọc.',
  'route.settings.label': 'Cài đặt',
  'route.settings.description':
    'Nhà cung cấp, mô hình, mức suy luận, ngôn ngữ, ngân sách, thông báo, cập nhật.',
  'route.export.label': 'Xuất bản',
  'route.export.description': 'Chọn chương, định dạng, nơi lưu, kết quả.',
  'error.malformed_json.title': 'Nhiễu giao thức',
  'error.malformed_json.description': 'Engine nhận được một dòng không thể phân tích.',
  'error.malformed_json.action': 'Nếu lỗi lặp lại, hãy khởi động lại engine từ Chẩn đoán.',
  'error.invalid_payload.title': 'Yêu cầu không hợp lệ',
  'error.invalid_payload.description': 'Yêu cầu bị từ chối vì dữ liệu không hợp lệ.',
  'error.invalid_payload.action': '',
  'error.unknown_method.title': 'Lệnh không được hỗ trợ',
  'error.unknown_method.description': 'Phiên bản engine này không hỗ trợ lệnh đó.',
  'error.unknown_method.action': '',
  'error.duplicate_request_id.title': 'Yêu cầu trùng lặp',
  'error.duplicate_request_id.description': 'Cùng một yêu cầu được gửi hai lần khi đang xử lý.',
  'error.duplicate_request_id.action': '',
  'error.project_unavailable.title': 'Chưa mở dự án',
  'error.project_unavailable.description': 'Thao tác này cần một dự án đang mở.',
  'error.project_unavailable.action': 'Hãy mở hoặc tạo dự án trước.',
  'error.host_busy.title': 'Engine đang bận',
  'error.host_busy.description': 'Một thao tác độc quyền khác đang chạy.',
  'error.host_busy.action': 'Hãy đợi thao tác đó xong, hoặc hủy nó trước.',
  'error.operation_failed.title': 'Thao tác thất bại',
  'error.operation_failed.description': 'Engine đã thử thực hiện nhưng thất bại.',
  'error.operation_failed.action': '',
  'error.cancelled.title': 'Đã hủy',
  'error.cancelled.description': 'Thao tác đã bị hủy trước khi hoàn tất.',
  'error.cancelled.action': '',
  'error.internal_error.title': 'Lỗi engine',
  'error.internal_error.description':
    'Engine báo lỗi nội bộ; trạng thái có thể không nhất quán.',
  'error.internal_error.action': 'Kiểm tra Chẩn đoán, rồi cân nhắc khởi động lại engine.',
  'error.engine_unavailable.title': 'Engine không khả dụng',
  'error.engine_unavailable.description': 'Engine chưa chạy hoặc đã dừng khi xử lý yêu cầu.',
  'error.engine_unavailable.action': 'Hãy đợi tự khởi động lại, hoặc khởi động engine lại.',
  'error.request_timeout.title': 'Yêu cầu quá hạn',
  'error.request_timeout.description': 'Engine không phản hồi kịp thời.',
  'error.request_timeout.action': '',
  'error.sidecar_error.title': 'Lỗi tiến trình engine',
  'error.sidecar_error.description': 'Không thể khởi động hoặc giám sát tiến trình engine.',
  'error.sidecar_error.action': 'Kiểm tra engine binary, rồi thử lại.',
  'error.invalid_path.title': 'Đường dẫn không hợp lệ',
  'error.invalid_path.description': 'Đường dẫn bị kiểm tra native từ chối.',
  'error.invalid_path.action': 'Hãy chọn đường dẫn tuyệt đối, không chứa đoạn di chuyển thư mục.',
  'error.unknown.title': 'Lỗi không xác định',
  'error.unknown.description': 'Engine gửi về một mã lỗi không nhận dạng được.',
  'error.unknown.action': '',
  'settings.languages.title': 'Ngôn ngữ',
  'settings.languages.interfaceLabel': 'ngôn ngữ giao diện',
  'settings.languages.setInterface': 'Đặt ngôn ngữ giao diện',
  'settings.languages.storyLabel': 'ngôn ngữ truyện',
  'settings.languages.setStory': 'Đặt ngôn ngữ truyện',
  'settings.languages.applying': 'Đang áp dụng…',
  'settings.languages.current': 'Hiện tại',
  'settings.languages.default': 'Mặc định',
  'settings.languages.hint': 'Engine chuẩn hóa mã (en / vi / zh) và trả về giá trị đã áp dụng. Giao diện áp dụng ngay; truyện áp dụng từ lần mở dự án tới.',
  'settings.empty.hint':
    'Cấu hình gắn với dự án — hãy mở hoặc tạo dự án từ màn hình Tổng quan.',
  'common.noProject.title': 'Chưa mở dự án',
};

const zh: Record<LocaleKey, string> = {
  'route.overview.label': '概览',
  'route.overview.description': '项目、进度、运行状态、恢复、预算、用量、近期事件、操作。',
  'route.write.label': '写作',
  'route.write.description': '大纲、流式内容、引导、暂停、中止、继续、重试、章节授权。',
  'route.chapters.label': '章节',
  'route.chapters.description': '列表、阅读、编辑、保存、未保存更改保护、修订同步、导出。',
  'route.artifacts.label': '素材',
  'route.artifacts.description': '大纲、角色、事实、世界观：只读投影。',
  'route.cocreate.label': '共创',
  'route.cocreate.description': '对话、分阶段流、审阅/编辑、继续、取消。',
  'route.import.label': '导入',
  'route.import.description': '来源选择、开始/继续/取消、进度、结果。',
  'route.simulation.label': '模拟',
  'route.simulation.description': '来源选择、开始/继续/取消、档案展示、档案导入。',
  'route.diagnostics.label': '诊断',
  'route.diagnostics.description': '发现、运行错误、会话、检查点、事件队列、脱敏导出。',
  'route.settings.label': '设置',
  'route.settings.description': '服务商、模型、思考级别、语言、预算、通知、更新。',
  'route.export.label': '导出',
  'route.export.description': '章节选择、格式、输出位置、结果。',
  'error.malformed_json.title': '协议噪声',
  'error.malformed_json.description': '引擎收到一行无法解析的内容。',
  'error.malformed_json.action': '如果反复出现，请从"诊断"页重启引擎。',
  'error.invalid_payload.title': '请求无效',
  'error.invalid_payload.description': '该请求的负载无效，已被拒绝。',
  'error.invalid_payload.action': '',
  'error.unknown_method.title': '不支持的命令',
  'error.unknown_method.description': '当前引擎版本未实现该命令。',
  'error.unknown_method.action': '',
  'error.duplicate_request_id.title': '重复请求',
  'error.duplicate_request_id.description': '同一请求在处理中被发送了两次。',
  'error.duplicate_request_id.action': '',
  'error.project_unavailable.title': '未打开项目',
  'error.project_unavailable.description': '此操作需要先打开一个项目。',
  'error.project_unavailable.action': '请先打开或创建一个项目。',
  'error.host_busy.title': '引擎忙',
  'error.host_busy.description': '另一个独占操作正在进行。',
  'error.host_busy.action': '请等待其完成，或先中止它。',
  'error.operation_failed.title': '操作失败',
  'error.operation_failed.description': '引擎尝试执行该操作但失败了。',
  'error.operation_failed.action': '',
  'error.cancelled.title': '已取消',
  'error.cancelled.description': '该操作在完成前被取消。',
  'error.cancelled.action': '',
  'error.internal_error.title': '引擎错误',
  'error.internal_error.description': '引擎报告内部故障；其状态可能不一致。',
  'error.internal_error.action': '请查看"诊断"，然后考虑重启引擎。',
  'error.engine_unavailable.title': '引擎不可用',
  'error.engine_unavailable.description': '引擎未运行，或在处理请求时退出。',
  'error.engine_unavailable.action': '请等待自动重启，或重新启动引擎。',
  'error.request_timeout.title': '请求超时',
  'error.request_timeout.description': '引擎未能及时响应。',
  'error.request_timeout.action': '',
  'error.sidecar_error.title': '引擎进程错误',
  'error.sidecar_error.description': '无法启动或监管引擎进程。',
  'error.sidecar_error.action': '请确认引擎可执行文件可用，然后重试。',
  'error.invalid_path.title': '路径无效',
  'error.invalid_path.description': '该路径未通过原生校验。',
  'error.invalid_path.action': '请选择不含遍历片段的绝对路径。',
  'error.unknown.title': '未知错误',
  'error.unknown.description': '引擎返回了一个无法识别的错误码。',
  'error.unknown.action': '',
  'settings.languages.title': '语言',
  'settings.languages.interfaceLabel': '界面语言',
  'settings.languages.setInterface': '设置界面语言',
  'settings.languages.storyLabel': '故事语言',
  'settings.languages.setStory': '设置故事语言',
  'settings.languages.applying': '应用中…',
  'settings.languages.current': '当前',
  'settings.languages.default': '默认',
  'settings.languages.hint': '引擎会规范化语言代码（en / vi / zh）并回显已应用的值。界面立即生效；故事语言下次打开项目时生效。',
  'settings.empty.hint': '配置与项目绑定——请从"概览"页打开或创建项目。',
  'common.noProject.title': '未打开项目',
};

/** All three catalog tables (English is the fallback). */
export const localeTables: Record<SupportedLanguage, Record<LocaleKey, string>> = { en, vi, zh };

/** Current chrome locale; synced from the engine-reported UI language. */
export const currentLanguage: Writable<SupportedLanguage> = writable('en');

function normalizeLanguage(code: unknown): SupportedLanguage | null {
  if (typeof code !== 'string') return null;
  const cleaned = code.trim().toLowerCase();
  if (cleaned === 'en' || cleaned === 'vi' || cleaned === 'zh') return cleaned;
  return null;
}

/**
 * Adopt an engine-reported language code (trims; unknown codes keep the
 * current locale since the engine may echo additive codes the chrome
 * catalog does not render yet). Returns the active locale.
 */
export function setLocale(code: unknown): SupportedLanguage {
  const next = normalizeLanguage(code);
  if (next === null) return get(currentLanguage);
  currentLanguage.set(next);
  return next;
}

/**
 * Look up a chrome string. Defaults to the current locale; an explicit but
 * unsupported language falls back to English, and an unknown key echoes
 * itself (never undefined — safe to render directly).
 */
export function t(key: string, lang?: string | null): string {
  const active: SupportedLanguage =
    lang === undefined || lang === null ? get(currentLanguage) : (normalizeLanguage(lang) ?? 'en');
  const hit = localeTables[active][key];
  if (hit !== undefined) return hit;
  const fallback = en[key];
  return fallback !== undefined ? fallback : key;
}
