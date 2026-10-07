import { useState } from 'react'
import {
  AlertTriangle,
  Cloud,
  Eye,
  FileDown,
  FileUp,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  Palette,
  Plus,
  RefreshCw,
  Type
} from 'lucide-react'
import type { ReaderTheme } from '@shared/types'
import { useApp } from '../store/app'
import { SegmentedControl, Slider, Switch } from '../components/ui'
import { FONT_STACKS, READER_THEMES, type FontKey } from '../lib/reader-theme'

const ACCENT_PRESETS = ['#3b6fd4', '#2fa36b', '#d97757', '#8b5cf6', '#e0a028', '#e05b7a', '#0ea5a5']

export function SettingsPage() {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const sync = useApp((s) => s.sync)
  const saveSettings = useApp((s) => s.saveSettings)
  const setSyncModal = useApp((s) => s.setSyncModal)
  const previewConflicts = useApp((s) => s.previewConflicts)
  const connectSync = useApp((s) => s.connectSync)
  const configureWebdav = useApp((s) => s.configureWebdav)
  const logoutSync = useApp((s) => s.logoutSync)
  const toast = useApp((s) => s.toast)

  const [nameDraft, setNameDraft] = useState<string | null>(null)
  // WebDAV 表单：null = 跟随设置（密码不回传，所以永远从空开始）
  const [davDraft, setDavDraft] = useState<{ url: string; username: string; password: string } | null>(null)
  const [davBusy, setDavBusy] = useState(false)

  if (!settings) return <div className="page" />

  const reader = settings.reader
  const syncSettings = settings.sync
  const appearance = settings.appearance
  const theme = READER_THEMES[reader.theme]
  const dav = davDraft ?? { url: syncSettings.webdav.url, username: syncSettings.webdav.username, password: '' }

  const patchReader = (patch: Partial<typeof reader>): void => {
    void saveSettings({ reader: { ...reader, ...patch } })
  }

  const patchSync = (patch: Partial<typeof syncSettings>): void => {
    void saveSettings({ sync: { ...syncSettings, ...patch } })
  }

  const patchAppearance = (patch: Partial<typeof appearance>): void => {
    void saveSettings({ appearance: { ...appearance, ...patch } })
  }

  const pickImage = async (field: 'backgroundImage' | 'readerBackgroundImage'): Promise<void> => {
    const kind = field === 'backgroundImage' ? 'app' : 'reader'
    // 由主进程复制进数据目录：协议只允许读取数据目录内的文件
    const stored = await window.api.appearance.pickBackdrop(kind)
    if (stored) {
      patchAppearance({ [field]: stored } as Partial<typeof appearance>)
      toast('success', '背景图已应用')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">设置</h1>
      </div>

      <div className="settings-wrap">
        {/* ---------- 阅读偏好 ---------- */}
        <section className="setting-card">
          <h3>
            <Type size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            阅读偏好
          </h3>
          <div className="setting-hint">这些设置会立即应用到阅读器，并保存在本机。</div>

          <div className="setting-row">
            <div>
              <div className="setting-label">字号</div>
              <div className="setting-desc">正文大小</div>
            </div>
            <div className="setting-control">
              <Slider value={reader.fontSize} min={14} max={30} onChange={(v) => patchReader({ fontSize: v })} />
              <span className="range-value">{reader.fontSize} px</span>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">行距</div>
              <div className="setting-desc">行与行之间的距离</div>
            </div>
            <div className="setting-control">
              <Slider
                value={reader.lineHeight}
                min={1.4}
                max={2.6}
                step={0.1}
                onChange={(v) => patchReader({ lineHeight: v })}
              />
              <span className="range-value">{reader.lineHeight.toFixed(1)}</span>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">版心宽度</div>
              <div className="setting-desc">正文区域最大宽度</div>
            </div>
            <div className="setting-control">
              <Slider
                value={reader.pageWidth}
                min={560}
                max={920}
                step={20}
                onChange={(v) => patchReader({ pageWidth: v })}
              />
              <span className="range-value">{reader.pageWidth} px</span>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">页边距</div>
              <div className="setting-desc">左右留白</div>
            </div>
            <div className="setting-control">
              <Slider
                value={reader.padding}
                min={12}
                max={80}
                step={4}
                onChange={(v) => patchReader({ padding: v })}
              />
              <span className="range-value">{reader.padding} px</span>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">字体</div>
              <div className="setting-desc">正文使用的字体族</div>
            </div>
            <div className="setting-control">
              <select
                className="select"
                value={reader.fontFamily}
                onChange={(e) => patchReader({ fontFamily: e.target.value as FontKey })}
              >
                {Object.entries(FONT_STACKS).map(([key, spec]) => (
                  <option key={key} value={key}>
                    {spec.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">阅读主题</div>
              <div className="setting-desc">只影响阅读器正文区域</div>
            </div>
            <div className="setting-control">
              <div className="theme-swatches">
                {(Object.keys(READER_THEMES) as ReaderTheme[]).map((key) => (
                  <button
                    key={key}
                    title={READER_THEMES[key].label}
                    className={`theme-swatch${reader.theme === key ? ' active' : ''}`}
                    style={{ background: READER_THEMES[key].swatch, color: READER_THEMES[key].text }}
                    onClick={() => patchReader({ theme: key })}
                  >
                    A
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">翻页方式</div>
              <div className="setting-desc">滚动阅读或按页翻动</div>
            </div>
            <div className="setting-control">
              <SegmentedControl<'scroll' | 'paged'>
                value={reader.mode}
                onChange={(v) => patchReader({ mode: v })}
                options={[
                  { value: 'scroll', label: '滚动' },
                  { value: 'paged', label: '翻页' }
                ]}
              />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">每日阅读目标</div>
              <div className="setting-desc">「今日阅读」环形进度按它计算，用来养成阅读习惯</div>
            </div>
            <div className="setting-control">
              <Slider
                value={settings.dailyGoalMinutes}
                min={10}
                max={180}
                step={5}
                onChange={(v) => void saveSettings({ dailyGoalMinutes: v })}
              />
              <span className="range-value">{settings.dailyGoalMinutes} 分钟</span>
            </div>
          </div>

          <div
            className="preview-box"
            style={{
              background: theme.bg,
              color: theme.text,
              fontSize: reader.fontSize,
              lineHeight: reader.lineHeight,
              fontFamily: FONT_STACKS[reader.fontFamily].css
            }}
          >
            <p>十月的风从窗缝里钻进来，翻动了桌上的书页。他把书按住，就着午后那点发白的光，又读了一页。</p>
            <p>“所谓阅读，不过是把别人的时间借来，安放在自己的生命里。”</p>
          </div>
        </section>

        {/* ---------- 外观 ---------- */}
        <section className="setting-card">
          <h3>
            <Palette size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            外观
          </h3>
          <div className="setting-hint">主题色会应用到按钮、进度环、选中状态；背景图会铺在主界面后面。</div>

          <div className="setting-row">
            <div>
              <div className="setting-label">主题色</div>
              <div className="setting-desc">点击色块选择，或用取色器自定义</div>
            </div>
            <div className="setting-control">
              <div className="accent-swatches">
                {ACCENT_PRESETS.map((color) => (
                  <button
                    key={color}
                    className={`accent-swatch${appearance.accent.toLowerCase() === color.toLowerCase() ? ' active' : ''}`}
                    style={{ background: color }}
                    title={color}
                    onClick={() => patchAppearance({ accent: color })}
                  />
                ))}
                <label className="accent-swatch accent-custom" title="自定义颜色">
                  <input
                    type="color"
                    value={appearance.accent}
                    onChange={(e) => patchAppearance({ accent: e.target.value })}
                  />
                  <Plus size={13} />
                </label>
              </div>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">应用背景图</div>
              <div className="setting-desc">
                {appearance.backgroundImage ? appearance.backgroundImage : '未设置，使用纯色背景'}
              </div>
            </div>
            <div className="setting-control">
              <button className="btn btn-ghost btn-sm" onClick={() => void pickImage('backgroundImage')}>
                <ImageIcon size={14} />
                选择图片
              </button>
              {appearance.backgroundImage ? (
                <button className="btn btn-ghost btn-sm" onClick={() => patchAppearance({ backgroundImage: null })}>
                  清除
                </button>
              ) : null}
            </div>
          </div>

          {appearance.backgroundImage ? (
            <div className="setting-row">
              <div>
                <div className="setting-label">背景浓度</div>
                <div className="setting-desc">背景图的显示强度</div>
              </div>
              <div className="setting-control">
                <Slider
                  value={appearance.backgroundOpacity}
                  min={0.05}
                  max={0.9}
                  step={0.05}
                  onChange={(v) => patchAppearance({ backgroundOpacity: v })}
                />
                <span className="range-value">{Math.round(appearance.backgroundOpacity * 100)}%</span>
              </div>
            </div>
          ) : null}

          <div className="setting-row">
            <div>
              <div className="setting-label">阅读器背景图</div>
              <div className="setting-desc">
                {appearance.readerBackgroundImage ? appearance.readerBackgroundImage : '未设置，使用阅读主题的底色'}
              </div>
            </div>
            <div className="setting-control">
              <button className="btn btn-ghost btn-sm" onClick={() => void pickImage('readerBackgroundImage')}>
                <ImageIcon size={14} />
                选择图片
              </button>
              {appearance.readerBackgroundImage ? (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => patchAppearance({ readerBackgroundImage: null })}
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {/* ---------- 网盘同步 ---------- */}
        <section className="setting-card">
          <h3>
            <Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            网盘同步
          </h3>
          <div className="setting-hint">
            把阅读进度与阅读时长同步到「云端」，两端读写同一批文件。
            本地文件夹适合单机或局域网（把目录指向共享盘）；WebDAV 适合两台设备隔着网络同步
            （坚果云等，填地址 + 账号 + 应用密码即可，不需要内嵌登录）。
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">云端类型</div>
              <div className="setting-desc">切换后云端目录各自独立，互不影响</div>
            </div>
            <div className="setting-control">
              <select
                className="select"
                value={syncSettings.provider}
                onChange={(e) => patchSync({ provider: e.target.value as 'local' | 'webdav' })}
              >
                <option value="local">本地文件夹</option>
                <option value="webdav">WebDAV（坚果云等）</option>
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">连接状态</div>
              <div className="setting-desc">
                {sync.loggedIn
                  ? `已连接：${sync.account ?? ''}`
                  : syncSettings.provider === 'webdav'
                    ? '尚未连接：填写下面的地址、账号、应用密码后点「保存并连接」'
                    : '尚未连接：先选一个目录作为云端'}
              </div>
            </div>
            <div className="setting-control">
              <span className={`sync-dot${sync.loggedIn ? ' on' : ''}`} />
              {syncSettings.provider === 'webdav' ? (
                <button className="btn btn-ghost btn-sm" onClick={() => void logoutSync()}>
                  退出登录
                </button>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => void connectSync()}>
                  {sync.loggedIn ? '更换目录' : '连接'}
                </button>
              )}
            </div>
          </div>

          {syncSettings.provider === 'webdav' ? (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">服务器地址</div>
                  <div className="setting-desc">坚果云：https://dav.jianguoyun.com/dav/</div>
                </div>
                <div className="setting-control">
                  <input
                    className="input"
                    style={{ width: 250 }}
                    placeholder="https://dav.example.com/dav/"
                    value={dav.url}
                    onChange={(e) => setDavDraft({ ...dav, url: e.target.value })}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">账号</div>
                  <div className="setting-desc">网盘的登录邮箱（坚果云用注册邮箱）</div>
                </div>
                <div className="setting-control">
                  <input
                    className="input"
                    style={{ width: 250 }}
                    value={dav.username}
                    onChange={(e) => setDavDraft({ ...dav, username: e.target.value })}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">应用密码</div>
                  <div className="setting-desc">
                    不是登录密码：坚果云在网页版「账户信息 → 安全选项 → 添加应用」生成。
                    存进系统凭据加密，已保存过就留空
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input"
                    style={{ width: 250 }}
                    type="password"
                    placeholder="留空则沿用已保存的"
                    value={dav.password}
                    onChange={(e) => setDavDraft({ ...dav, password: e.target.value })}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">保存并连接</div>
                  <div className="setting-desc">会先验证一次地址与密码，然后立刻跑一轮同步</div>
                </div>
                <div className="setting-control">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={davBusy}
                    onClick={() => {
                      setDavBusy(true)
                      void configureWebdav({ url: dav.url, username: dav.username, password: dav.password }).finally(
                        () => {
                          setDavBusy(false)
                          setDavDraft(null)
                        }
                      )
                    }}
                  >
                    {davBusy ? '连接中…' : '保存并连接'}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          <div className="setting-row">
            <div>
              <div className="setting-label">云端同步文件夹</div>
              <div className="setting-desc">在云端目录下使用哪个子文件夹；不存在时自动创建</div>
            </div>
            <div className="setting-control">
              <input
                className="input"
                value={nameDraft ?? syncSettings.remoteDir}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  if (nameDraft !== null && nameDraft.trim()) patchSync({ remoteDir: nameDraft.trim() })
                  setNameDraft(null)
                }}
              />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">自动同步</div>
              <div className="setting-desc">启动后同步一次，并按间隔定时同步</div>
            </div>
            <div className="setting-control">
              <Switch checked={syncSettings.auto} onChange={(v) => patchSync({ auto: v })} />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">退出阅读时同步</div>
              <div className="setting-desc">
                合上书立刻把进度与阅读时长推上云端；退出应用前也会同步一次。
                网络失败不影响阅读，下次会自动补上
              </div>
            </div>
            <div className="setting-control">
              <Switch
                checked={syncSettings.onReaderClose}
                onChange={(v) => patchSync({ onReaderClose: v })}
              />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">同步间隔</div>
              <div className="setting-desc">自动同步的时间间隔</div>
            </div>
            <div className="setting-control">
              <select
                className="select"
                disabled={!syncSettings.auto}
                value={syncSettings.intervalMinutes}
                onChange={(e) => patchSync({ intervalMinutes: Number(e.target.value) })}
              >
                {[5, 10, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    每 {m} 分钟
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">冲突处理</div>
              <div className="setting-desc">同一本书两端都有新进度时的默认行为</div>
            </div>
            <div className="setting-control">
              <select
                className="select"
                value={syncSettings.conflictPolicy}
                onChange={(e) => patchSync({ conflictPolicy: e.target.value as 'ask' | 'local' | 'cloud' })}
              >
                <option value="ask">总是询问我</option>
                <option value="local">优先本地</option>
                <option value="cloud">优先云端</option>
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">同步书籍文件</div>
              <div className="setting-desc">
                当前版本只同步阅读进度。书籍本体上传（按 Book.syncUpload 逐本控制）尚未接入
              </div>
            </div>
            <div className="setting-control">
              <Switch checked={syncSettings.uploadBooks} onChange={(v) => patchSync({ uploadBooks: v })} />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">立即操作</div>
              <div className="setting-desc">打开同步状态面板，查看任务、进度与冲突</div>
            </div>
            <div className="setting-control">
              <button className="btn btn-primary btn-sm" onClick={() => setSyncModal(true)}>
                <RefreshCw size={14} />
                立即同步
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">手动导出 / 导入</div>
              <div className="setting-desc">网盘不可用时的兜底通道：把进度文件导出或导入</div>
            </div>
            <div className="setting-control">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => toast('info', '导出/导入进度文件尚未接入')}
              >
                <FileDown size={14} />
                导出
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => toast('info', '导出/导入进度文件尚未接入')}
              >
                <FileUp size={14} />
                导入
              </button>
            </div>
          </div>
        </section>

        {/* ---------- 数据与存储 ---------- */}
        <section className="setting-card">
          <h3>
            <HardDrive size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            数据与存储
          </h3>
          <div className="setting-hint">书库、封面、阅读进度与统计都保存在本机这个目录，关机重启不会丢失。</div>

          <div className="setting-row">
            <div>
              <div className="setting-label">数据目录</div>
              <div className="setting-path" style={{ marginTop: 8 }}>
                {info?.dataDir ?? '—'}
              </div>
            </div>
            <div className="setting-control">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => info && void window.api.app.openPath(info.dataDir)}
              >
                <FolderOpen size={14} />
                打开目录
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">界面主题</div>
              <div className="setting-desc">应用整体外观</div>
            </div>
            <div className="setting-control">
              <SegmentedControl<'light' | 'dark'>
                value={settings.theme}
                onChange={(v) => void saveSettings({ theme: v })}
                options={[
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' }
                ]}
              />
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">本机设备名</div>
              <div className="setting-desc">同步时用于标记进度来自哪台设备</div>
            </div>
            <div className="setting-control">
              <span className="setting-path">{settings.deviceName}</span>
            </div>
          </div>
        </section>

        {/* ---------- 关于 ---------- */}
        <section className="setting-card">
          <h3>
            <Info size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            关于
          </h3>
          <div className="setting-row">
            <div>
              <div className="setting-label">版本</div>
            </div>
            <div className="setting-control">
              <span className="setting-hint">v{info?.version ?? '0.1.0'} · 第一阶段（页面结构与交互）</span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">支持格式</div>
            </div>
            <div className="setting-control">
              <span className="setting-hint">当前版本仅支持 EPUB，其余格式将在后续版本补充</span>
            </div>
          </div>
        </section>

        {/* ---------- 设计阶段预览入口 ---------- */}
        <section className="setting-card">
          <h3>
            <Eye size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            界面预览（设计阶段临时入口）
          </h3>
          <div className="setting-hint">
            同步引擎已接入（本地文件夹模式）。下面两个入口用于单独预览同步弹窗的界面。
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">同步状态弹窗</div>
              <div className="setting-desc">任务计数 · 进度条 · 上次同步时间 · 立即同步 / 取消同步 / 全部下载</div>
            </div>
            <div className="setting-control">
              <button className="btn btn-ghost btn-sm" onClick={() => setSyncModal(true)}>
                预览
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">进度冲突弹窗</div>
              <div className="setting-desc">
                <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                使用两本示例书籍展示「覆盖云端 / 覆盖本地」的选择交互
              </div>
            </div>
            <div className="setting-control">
              <button className="btn btn-ghost btn-sm" onClick={previewConflicts}>
                预览
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
