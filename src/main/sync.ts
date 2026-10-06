import type { ConflictItem, SyncState } from '../shared/types'

/**
 * 网盘同步服务（第一阶段为占位实现）。
 *
 * 已确定的实现路线（M5 落地）：
 *  1. 在应用内打开 pan.baidu.com 内嵌窗口，由用户本人登录（支持扫码 / 短信验证码）；
 *  2. 登录态保存在本机 session 分区，失效时提示重新登录；
 *  3. 复用网盘网页自身的文件接口完成列目录 / 分片上传 / 下载；
 *  4. 云端目录结构：/DshReader/{manifest.json, books/<hash>.<ext>, progress/<bookId>.json, devices/<deviceId>.json}；
 *  5. 书籍文件按需上传（默认只同步进度），冲突时按设置弹窗询问。
 *
 * 本阶段只暴露与 UI 一致的状态机，所有操作都会返回诚实的状态说明，不会伪造同步进度。
 */
export class SyncService {
  private state: SyncState = {
    phase: 'idle',
    loggedIn: false,
    account: null,
    lastSyncAt: null,
    tasks: [],
    transferred: 0,
    total: 0,
    message: '尚未连接百度网盘'
  }

  private conflicts: ConflictItem[] = []

  status(): SyncState {
    return this.state
  }

  pendingConflicts(): ConflictItem[] {
    return this.conflicts
  }

  async connect(): Promise<SyncState> {
    this.state = {
      ...this.state,
      message: '百度网盘登录窗口将在同步阶段（M5）接入，当前可在设置中预览同步界面。'
    }
    return this.state
  }

  async run(): Promise<SyncState> {
    this.state = {
      ...this.state,
      phase: 'idle',
      message: this.state.loggedIn ? '同步引擎将在 M5 接入。' : '请先连接百度网盘账号。'
    }
    return this.state
  }

  async cancel(): Promise<SyncState> {
    this.state = { ...this.state, phase: 'idle', message: '已取消同步' }
    return this.state
  }

  async downloadAll(): Promise<SyncState> {
    this.state = { ...this.state, message: '「全部下载」将在 M5 接入。' }
    return this.state
  }

  async resolve(_items: ConflictItem[], _choice: 'local' | 'cloud'): Promise<SyncState> {
    this.conflicts = []
    this.state = { ...this.state, phase: 'idle', message: '冲突处理将在 M5 接入。' }
    return this.state
  }
}
