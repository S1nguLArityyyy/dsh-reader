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
  const [logOpen, setLogOpen] = useState(false)
  const info = useApp((s) => s.info)
  const sync = useApp((s) => s.sync)
  const saveSettings = useApp((s) => s.saveSettings)
  const setSyncModal = useApp((s) => s.setSyncModal)
  const previewConflicts = useApp((s) => s.previewConflicts)
  const connectSync = useApp((s) => s.connectSync)
  const logoutSync = useApp((s) => s.logoutSync)
  const markAllSyncUpload = useApp((s) => s.markAllSyncUpload)
  const toast = useApp((s) => s.toast)


  if (!settings) return <div className="page" />

  const reader = settings.reader
  const syncSettings = settings.sync
  const appearance = settings.appearance
  const theme = READER_THEMES[reader.theme]

  const patchReader = (patch: Partial<typeof reader>): void => {
    void saveSettings({ reader: { ...reader, ...patch } })
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
        {/* ---------- 关于 ---------- */}
        <section className="setting-card">
          <h3>关于</h3>
          <div className="setting-row">
            <div>
              <div className="setting-label">更新记录</div>
              <div className="setting-desc">查看各版本的功能变化</div>
            </div>
            <div className="setting-control">
              <button className="btn btn-ghost btn-sm" onClick={() => setLogOpen(true)}>
                查看
              </button>
            </div>
          </div>

          {logOpen ? (
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900 }}
              onClick={() => setLogOpen(false)}
            >
              <div
                style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 560, maxHeight: '76vh', background: 'var(--panel)', borderRadius: 14, padding: 20, overflowY: 'auto' }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 style={{ margin: '0 0 14px' }}>更新记录</h3>
                <div className="setting-desc" style={{ lineHeight: 1.9 }}>
                  <b>1.0 正式版</b>
                  <br />局域网直连：同一 WiFi 下与手机交换阅读记录和书籍，不再依赖网盘
                  <br />记录双向同步：进度、时长、读完标记；桌面端作为服务端常驻
                  <br />收到手机记录后自动重读并刷新界面
                  <br />书架按系列归组、按卷号排序，支持整目录批量导入
                  <br />统计：阅读日历、阅读热力图、按区间汇总
                  <br />
                  <br />
                  <b>0.9</b>
                  <br />记录同步协议完成：进度按时间取新，时长按设备分别累计
                  <br />书籍增量传输：只发送手机缺少的那几本
                  <br />
                  <br />
                  <b>0.8</b>
                  <br />改用局域网直传书籍，速度提升到秒级
                  <br />移除网盘与 WebDAV 同步
                  <br />
                  <br />
                  <b>0.7</b>
                  <br />阅读器：翻页模式、目录跳转、全文搜索、样式编辑
                  <br />书库：搜索、多选管理、合集归组、导入进度
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setLogOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>


        {/* ---------- 网盘同步 ---------- */}
        {/* ---------- 局域网服务 ---------- */}
        <section className="setting-card">
          <h3>局域网服务</h3>
          <div className="setting-hint">
            手机在同一个 WiFi 下直接连本机交换阅读记录与书籍。把服务地址填进手机端的「局域网同步」即可。
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">服务地址</div>
              <div className="setting-desc">形如 http://192.168.x.x:8787，端口固定 8787</div>
            </div>
            <div className="setting-control">
              <span className="setting-hint">启动时写入 lan.txt</span>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">地址文件</div>
              <div className="setting-desc">{info?.dataDir ? info.dataDir + '\lan.txt' : '数据目录下的 lan.txt'}</div>
            </div>
            <div className="setting-control">
              <span className="setting-hint">故障排查用</span>
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
      </div>
    </div>
  )
}
