/** MailChat 统一 1.5px 方端几何图标系统（C2 双折面主标 + 24 枚客户端专属矢量图标，融合项目清透蓝石板色系） */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 01 · MARK — C2 中心对称 45° 双折面品牌主图标（适配项目 #FFFFFF + #0F172A + #3563E9 清透雾蓝色系） */
export function BrandAppIcon({ size = 38, ...rest }: IconProps) {
  const dotRadius = size <= 24 ? 11 : size <= 40 ? 9 : 7.8;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      <path
        d="M128 16 C200 16 240 56 240 128 C240 200 200 240 128 240 C56 240 16 200 16 128 C16 56 56 16 128 16 Z"
        fill="var(--surface-card, #FFFFFF)"
        stroke="var(--hairline, #E2E8F0)"
        strokeWidth="2.2"
      />
      <path
        d="M128 23 C195 23 233 61 233 128 C233 195 195 233 128 233 C61 233 23 195 23 128 C23 61 61 23 128 23 Z"
        stroke="var(--surface-subtle, #F1F5F9)"
        strokeWidth="1.2"
      />
      <path d="M128 70 L70 128 L99 157 L128 128 Z" fill="var(--ink, #0F172A)" />
      <path d="M128 128 L157 99 L186 128 L128 186 Z" fill="var(--ink, #0F172A)" />
      <circle cx="178.5" cy="77.5" r={dotRadius} fill="var(--accent, #3563E9)" />
    </svg>
  );
}

/** 01b · 单色缩微双折面徽标 */
export function IconMail(p: IconProps) {
  return (
    <svg
      width={p.size ?? 18}
      height={p.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...p}
    >
      <path d="M12 4.5 4.5 12 8.25 15.75 12 12Z" fill="currentColor" />
      <path d="M12 12 15.75 8.25 19.5 12 12 19.5Z" fill="currentColor" />
      <circle cx="18.2" cy="5.8" r="1.8" fill="var(--accent, #3563e9)" />
    </svg>
  );
}

/** 02 · INBOX — 消息主槽（直角对话折框 + 单横尺） */
export function IconChat(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 5.5H20V17H8.5L4 20.5V5.5Z" />
      <path d="M8.5 10.5H15.5" />
    </Base>
  );
}

/** 03 · ARCHIVED — 折叠通知尺（左侧装订竖尺 + 三道递减横线） */
export function IconBell(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5 5V19" />
      <path d="M9 7.5H19.5M9 12H16.5M9 16.5H13.5" />
    </Base>
  );
}

/** 04 · BLOCKED — 静默拦截光阑（正圆 + 45° 斜切封锁线） */
export function IconShield(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M6.8 17.2 17.2 6.8" />
    </Base>
  );
}

/** 05 · AGENT — 声明式助手终端框（去除四芒星 ✦） */
export function IconSparkles(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M8 9.5 11 12 8 14.5M12.5 14.5H16" />
    </Base>
  );
}

/** 06 · CONFIG — 配置推子（双轨水平刻度线 + 矩形机械推子） */
export function IconSliders(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 8.25H7.5M11.5 8.25H20M4 15.75H13M17 15.75H20" />
      <rect x="7.5" y="5.75" width="4" height="5" />
      <rect x="13" y="13.25" width="4" height="5" />
    </Base>
  );
}

/** 07 · DIRECT — 新建单聊（正交十字准星） */
export function IconPlus(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 5V19M5 12H19" />
    </Base>
  );
}

/** 08 · GROUP — 跨服邮件群聊总线（三个方形节点经 Y 型总线互通） */
export function IconUsers(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="10.25" y="3.75" width="3.5" height="3.5" />
      <rect x="3.75" y="16.25" width="3.5" height="3.5" />
      <rect x="16.75" y="16.25" width="3.5" height="3.5" />
      <path d="M12 7.5V12.5M12 12.5 6.5 16.25M12 12.5 17.5 16.25" />
    </Base>
  );
}

/** 09 · TRIAGE — AI 智能重分拣（双路分流折线 + 分拣命中节点） */
export function IconTriage(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 12H10L13.5 7H20M10 12 13.5 17H20" />
      <rect x="18" y="5.5" width="2.5" height="2.5" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 10 · SYNC — IMAP 立即同步（上下双向直角回路箭头） */
export function IconRefresh(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 10V5.5H18.5M15.5 2.75 18.5 5.5 15.5 8.25" />
      <path d="M19.5 14V18.5H5.5M8.5 15.75 5.5 18.5 8.5 21.25" />
    </Base>
  );
}

/** 11 · SEARCH — 检索刻度镜（正圆 + 45° 方端手柄） */
export function IconSearch(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.2 15.2 4.3 4.3" />
    </Base>
  );
}

/** 12 · SUMMARY — 纪要提炼（页边竖尺 + 锚点 + 三行提要尺） */
export function IconNote(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M7.5 4.5V19.5" />
      <rect x="3.75" y="7" width="2.2" height="2.2" fill="var(--accent, #3563e9)" stroke="none" />
      <path d="M11 8H19.5M11 12.5H17.5M11 17H14.5" />
    </Base>
  );
}

/** 13 · DRAFT — 五档辅助起草（45° 机械制图笔尖 + 基准底线） */
export function IconDraft(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5 19H19M7 14.5 15.5 6 18 8.5 9.5 17H7V14.5Z" />
    </Base>
  );
}

/** 14 · SUBJECT — 邮件主题井字标尺 */
export function IconTag(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 9.5H19.5M4.5 14.5H19.5M9.5 5 8 19M16 5 14.5 19" />
    </Base>
  );
}

/** 15 · SEND — 机械回车发送折线箭头 */
export function IconSend(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M18.5 6V13.5H6.5M10.5 9.5 6.5 13.5 10.5 17.5" />
    </Base>
  );
}

/** 16 · MUTE — 群免打扰标识（直角扬声器切面 + 静音交叉切线） */
export function IconMute(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 9.5H8L12.5 5.5V18.5L8 14.5H4.5V9.5Z" />
      <path d="M16 9.5 20 14.5M20 9.5 16 14.5" />
    </Base>
  );
}

/** 17 · OTP — 验证码键帽（横向矩形键帽 + 三道数字刻线） */
export function IconOtp(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3.5" y="6.75" width="17" height="10.5" />
      <path d="M8 10.25V13.75M12 10.25V13.75M16 10.25V13.75" />
    </Base>
  );
}

/** 17b · COPY — 双层直角复制框 */
export function IconCopy(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" />
      <path d="M5.5 15.5H4V4H15.5V5.5" />
    </Base>
  );
}

/** 18 · TOML — config.toml 声明式清单方折括号 */
export function IconCode(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M8.5 7 4 12 8.5 17M15.5 7 20 12 15.5 17M13.2 6 10.8 18" />
    </Base>
  );
}

/** 19 · VAULT — Windows DPAPI 同心双环卡口锁 */
export function IconLock(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="7.75" />
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 4.25V8.75" />
      <circle cx="17.5" cy="6.5" r="1.5" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 20 · SECRET — secret:* 盲注入密钥柄 */
export function IconKey(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="8.5" width="7" height="7" />
      <path d="M11 12H20M17 12V15.5M19.5 12V14.5" />
    </Base>
  );
}

/** 21 · PLUGIN — 免编译双插针模块 */
export function IconPlugin(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5 7.5H19V19H5V7.5Z" />
      <path d="M8.5 4.5V7.5M15.5 4.5V7.5" />
      <rect x="10.75" y="11.75" width="2.5" height="2.5" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 22 · PIN — 窗口置顶（顶部水平基准线 + 向上锁定箭头） */
export function IconPin(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M6 5H18M12 8.5V19M8.5 12 12 8.5 15.5 12" />
    </Base>
  );
}

/** 23a · WINBOX — 窗口最大化单线直角框 */
export function IconWinMaximize(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="5.5" y="5.5" width="13" height="13" />
    </Base>
  );
}

/** 23b · WINBOX RESTORE — 窗口向下还原双层直角框 */
export function IconWinRestore(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4.5" y="7.5" width="12" height="12" />
      <path d="M7.5 7.5V4.5H19.5V16.5H16.5" />
    </Base>
  );
}

/** 23c · WIN MINIMIZE — 窗口最小化水平基准线 */
export function IconWinMinimize(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5 12H19" />
    </Base>
  );
}

/** 24 · CLOSE — 对角正交关闭切线 */
export function IconClose(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Base>
  );
}

/** CHECK — 正交确认折线 */
export function IconCheck(p: IconProps) {
  return (
    <Base {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Base>
  );
}

/** LINK — 邮件内联动作卡片正交链扣 */
export function IconLink(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M9.5 7.5H4.5V16.5H9.5M14.5 7.5H19.5V16.5H14.5M8.5 12H15.5" />
    </Base>
  );
}

/** EXTERNAL LINK — 外链跳转直角框与 45° 出射轴 */
export function IconExternalLink(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M10.5 5.5H5V19H18.5V13.5M14 5H19V10M19 5 11 13" />
    </Base>
  );
}

/** 25 · HISTORY — 历史会话时间轴与侧栏刻度 */
export function IconHistory(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8V12.25L15 14" />
    </Base>
  );
}

/** 26 · TRASH — 几何删除框 */
export function IconTrash(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5 7H19M9.5 7V4.5H14.5V7M7.5 7V19.5H16.5V7M10.5 11V15.5M13.5 11V15.5" />
    </Base>
  );
}

/** 27 · STOP — 中断流式输出正方停止键 */
export function IconStop(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 28 · CHEVRON — 几何直角折角箭头 */
export function IconChevron(p: IconProps) {
  return (
    <Base {...p}>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </Base>
  );
}

/** 29 · THINK — 推理思考逻辑脉冲折线 */
export function IconThink(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 12H7.5L10 6.5L14 17.5L16.5 12H20" />
    </Base>
  );
}

/** 30 · MORE — 联系人/会话详情三点矩阵 */
export function IconMore(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4.5" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="10.75" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="17" y="10.75" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 31 · PAPERCLIP — 几何直角回形针附件标识 */
export function IconPaperclip(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M15.5 7.5V16.5H8.5V6H17.5V18.5H6.5V8.5" />
    </Base>
  );
}

/** 32 · IMAGE — 发送图片/相册取景框 */
export function IconImage(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="5" width="16" height="14" />
      <circle cx="8.75" cy="9.5" r="1.5" />
      <path d="m5.5 17 4.5-4.5 3 3 2.5-2.5 3 4" />
    </Base>
  );
}

/** 33 · FILE — 折角文件卡片标识 */
export function IconFile(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M6 4.5H14L18.5 9V19.5H6V4.5Z" />
      <path d="M13.5 4.5V9.5H18.5" />
      <path d="M9 13H15M9 16H13.5" />
    </Base>
  );
}

/** 34 · FOLDER — 本地目录定位夹 */
export function IconFolder(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 6.5H9.5L11.5 8.5H20V18.5H4V6.5Z" />
    </Base>
  );
}

/** 35 · REPLY — 引用回复消息折角左向箭头 */
export function IconReply(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M9.5 7 4.5 11.5 9.5 16" />
      <path d="M5 11.5H16.5V18" />
    </Base>
  );
}

/** 36 · ARROW UP — 搜索上一处匹配 */
export function IconArrowUp(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 18.5V5.5M7 10.5 12 5.5 17 10.5" />
    </Base>
  );
}

/** 37 · ARROW DOWN — 搜索下一处匹配 */
export function IconArrowDown(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 5.5V18.5M7 13.5 12 18.5 17 13.5" />
    </Base>
  );
}

/** 38 · EDIT — 备注编辑标尺笔 */
export function IconEdit(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M14.5 5.5 18.5 9.5 9 19H5V15L14.5 5.5Z" />
    </Base>
  );
}

/** 39 · SMILE — 表情面板微笑轮廓 */
export function IconSmile(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="9.25" cy="10.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="10.25" r="0.9" fill="currentColor" stroke="none" />
      <path d="M8.5 14.2C9.4 15.5 10.6 16.1 12 16.1C13.4 16.1 14.6 15.5 15.5 14.2" />
    </Base>
  );
}

/** 40 · SCISSORS — 剪切剪刀标识 */
export function IconScissors(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="7" cy="7.5" r="2.5" />
      <circle cx="7" cy="16.5" r="2.5" />
      <path d="M9.1 9L19 17.5M19 6.5L9.1 15" />
    </Base>
  );
}

/** 41 · AT — 群聊 @提及标识 */
export function IconAt(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M15.2 12V13.6C15.2 14.9 16.1 15.6 17.1 15.6C18.4 15.6 19.5 14.3 19.5 12C19.5 7.86 16.14 4.5 12 4.5C7.86 4.5 4.5 7.86 4.5 12C4.5 16.14 7.86 19.5 12 19.5C13.8 19.5 15.4 18.95 16.6 18" />
    </Base>
  );
}

/** 42 · FORWARD — 消息转发右向折线箭头 */
export function IconForward(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M14.5 7 19.5 11.5 14.5 16" />
      <path d="M19 11.5H7.5V18" />
    </Base>
  );
}

/** 43 · MAIL READ — 标为已读（翻盖开启的几何信封） */
export function IconMailRead(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 9.5 12 4.5 20 9.5V19H4V9.5Z" />
      <path d="m4.5 10 7.5 4.8L19.5 10" />
    </Base>
  );
}

/** 44 · MAIL UNREAD — 标为未读（闭合信封 + 蓝点未读指示） */
export function IconMailUnread(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M19.5 10.5V18.5H4V6.5H14" />
      <path d="m4.5 7 7.5 5.2 3.5-2.4" />
      <circle cx="18.5" cy="6.5" r="2.2" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 45 · PASTE — 剪贴板粘贴框 */
export function IconPaste(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M8.5 5.5H5.5V19.5H18.5V5.5H15.5" />
      <rect x="8.5" y="3.75" width="7" height="3.5" />
      <path d="M9 11.5H15M9 15H13.5" />
    </Base>
  );
}

/** 46 · SELECT ALL — 全选边界刻度框 */
export function IconSelectAll(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 8V4.5H8M16 4.5H19.5V8M19.5 16V19.5H16M8 19.5H4.5V16" />
      <rect x="8.5" y="8.5" width="7" height="7" />
    </Base>
  );
}

/** 47 · UNMUTE — 恢复提醒扬声器声波切线 */
export function IconUnmute(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 9.5H8L12.5 5.5V18.5L8 14.5H4.5V9.5Z" />
      <path d="M16 9V15M19 7V17" />
    </Base>
  );
}

/** 48 · DOWNLOAD — 手动另存为下载指示器 */
export function IconDownload(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 4.5V14.5" />
      <path d="M8 11L12 15L16 11" />
      <path d="M4.5 16.5V19.5H19.5V16.5" />
    </Base>
  );
}

/** 49 · ALERT — 高危可执行附件安全警示 */
export function IconAlert(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 4.2L20.2 18.8H3.8L12 4.2Z" />
      <path d="M12 9.8V13.8" />
      <circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 50 · UNDO — 对话检查点回退左折回环箭头 */
export function IconUndo(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M8.5 5.5 4.5 9.5 8.5 13.5" />
      <path d="M5 9.5H15.5C18 9.5 19.5 11 19.5 13.5C19.5 16 18 17.5 15.5 17.5H10" />
    </Base>
  );
}

/** 51 · PALETTE — 声明式界面主题调色网格与高光色点 */
export function IconPalette(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M4 11.5H20M11.5 4V20" />
      <rect x="6.5" y="6.5" width="2.5" height="2.5" fill="var(--accent, #3563e9)" stroke="none" />
      <rect x="14.5" y="14.5" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 52 · SUN — 浅色日间模式八向刻度盘 */
export function IconSun(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.5V5.5M12 18.5V20.5M3.5 12H5.5M18.5 12H20.5M6 6 7.5 7.5M16.5 16.5 18 18M18 6 16.5 7.5M7.5 16.5 6 18" />
    </Base>
  );
}

/** 53 · MOON — 深色暗夜模式弦月弧 */
export function IconMoon(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" />
    </Base>
  );
}

/** 54 · MONITOR — 跟随系统显示模式框 */
export function IconMonitor(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3.5" y="4.5" width="17" height="11.5" />
      <path d="M9 19.5H15M12 16V19.5" />
    </Base>
  );
}

/** 55 · COMPOSE — 传统信笺框 + Agent 排版游标（写信工坊） */
export function IconCompose(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12.5 4.5H5V19.5H19V11.5" />
      <path d="M16.5 3.8 20.2 7.5 11.8 15.9H8.1V12.2L16.5 3.8Z" />
      <rect x="7.5" y="7.5" width="3" height="1.5" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 56 · REPLY HUB — 多邮箱层叠收件匣 + 隐私护盾勾选（统一批复中心） */
export function IconReplyHub(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 8H17V18.5H4V8Z" />
      <path d="M7 5H20V15.5" />
      <path d="m7.5 13 2.5 2.5 4.5-4.5" />
    </Base>
  );
}

/** 57 · EYE — 入模脱敏审计透视眼 */
export function IconEye(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M2.8 12C4.8 7.8 8.1 5.8 12 5.8S19.2 7.8 21.2 12C19.2 16.2 15.9 18.2 12 18.2S4.8 16.2 2.8 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Base>
  );
}

/** 58 · SPLIT — 源码与沙箱实时双栏分屏视图 */
export function IconSplit(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" />
      <path d="M12 4.5V19.5" />
    </Base>
  );
}

/** 59 · UPDATE — 客户端签名热更新指示徽标（底座承盘 + 向上升级轴 + 签名高光点） */
export function IconUpdate(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 14.5V19.5H19.5V14.5" />
      <path d="M12 15V5.5M8 9.5 12 5.5 16 9.5" />
      <circle cx="18.25" cy="5.75" r="1.6" fill="var(--accent, #3563e9)" stroke="none" />
    </Base>
  );
}

/** 60 · AGENT DOCK — 右侧邮件智能体分栏面板切换图标（窗口外框 + 右侧停靠栏 + AI 星芒） */
export function IconAgentDock(p: IconProps & { open?: boolean }) {
  const { open, ...rest } = p;
  return (
    <Base {...rest}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.2 4.5V19.5" />
      {open && (
        <rect
          x="15.35"
          y="5.9"
          width="3.75"
          height="12.2"
          rx="0.9"
          fill="currentColor"
          fillOpacity="0.22"
          stroke="none"
        />
      )}
      <path
        d="M8.8 9.1 9.55 11.15 11.6 11.9 9.55 12.65 8.8 14.7 8.05 12.65 6 11.9 8.05 11.15Z"
        fill="var(--accent, #3563e9)"
        stroke="none"
      />
    </Base>
  );
}
