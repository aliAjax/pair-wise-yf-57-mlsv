import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------
export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type Risk = 'low' | 'medium' | 'high';

/** 交接段动作：采集 → 交接 → 接收 → 送检，退回 / 补齐为追加段，核验为终点 */
export type HandoverAction =
  | 'collected'
  | 'handed_over'
  | 'received'
  | 'submitted'
  | 'verified'
  | 'rejected'
  | 'supplemented';

/** 样本交接段：逐段留痕，不可修改（immutable），退回只作废后续段 */
export interface HandoverSegment {
  id: string;
  action: HandoverAction;
  at: string;
  by: string;
  location?: { lat: number; lng: number };
  note?: string;
  /** 不可改标记 */
  immutable: true;
  /** 退回后作废的后续段（记录仍保留，不删除） */
  voided?: boolean;
}

export interface ReviewConclusion {
  pass: boolean;
  at: string;
  by: string;
  reasons: string[];
  missingMaterials: string[];
}

export interface PatrolObservation {
  id: string;
  /** 设备内业务键（用于去重） */
  clientKey: string;
  /** 稳定巡护标识 */
  patrolId: string;
  deviceId: string;
  time: string;
  note: string;
  risk: Risk;
  sync: SyncState;
  reviewed: boolean;
  review?: ReviewConclusion;
  /** 证据说明；缺失则触发“缺失证据” */
  evidence?: string;
  location?: { lat: number; lng: number };
}

export interface TrackPoint {
  id: string;
  clientKey: string;
  patrolId: string;
  deviceId: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
}

export type SampleStatus =
  | 'draft'
  | 'collected'
  | 'in_transit'
  | 'received'
  | 'submitted'
  | 'verified'
  | 'rejected';

export interface Sample {
  id: string;
  clientKey: string;
  patrolId: string;
  deviceId: string;
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  /** 交接链：只追加，不可改 */
  handovers: HandoverSegment[];
  collector: string;
  createdAt: string;
  /** 旧记录升级标记：只有采集人和时间 */
  legacy?: boolean;
  /** 退回后补齐的继续点（从退回点继续） */
  resumeStage?: SampleStatus;
  /** 退回原因（最近一次） */
  rejectReason?: string;
}

// ---------------------------------------------------------------------------
// 巡护包
// ---------------------------------------------------------------------------
export type PacketEntryKind = 'observation' | 'point' | 'sample';

export interface PacketEntry {
  /** 包内条目业务键 */
  key: string;
  kind: PacketEntryKind;
  payload: Record<string, any>;
}

export type EntryResultStatus = 'accepted' | 'duplicate' | 'failed' | 'conflict';

export interface EntryResult {
  key: string;
  kind: PacketEntryKind;
  status: EntryResultStatus;
  reason?: string;
  missingMaterials?: string[];
}

export interface PatrolPacket {
  id: string;
  deviceId: string;
  patrolId: string;
  /** 设备内连续序号（单调递增，不随设备时间回拨而乱序） */
  seq: number;
  createdAt: string;
  entries: PacketEntry[];
  /** 处理结果（重传沿用第一次结果） */
  results?: EntryResult[];
  status: 'open' | 'processed';
  /** 重传次数 */
  retransmitted?: number;
}

export interface ReviewerScope {
  name: string;
  /** 能力范围：可复核的最高风险等级 */
  maxRisk: Risk;
  /** 负责区域（用于位置异常判断） */
  area: { lat: number; lng: number; radiusKm: number };
}

interface State {
  deviceId: string;
  patrolId: string;
  /** 设备内包序号计数（连续） */
  deviceSeq: number;
  packets: PatrolPacket[];
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  conflict: string | null;
  reviewer: ReviewerScope;
  /** 待补材料汇总（按业务对象） */
  missingMaterials: { observationId?: string; sampleId?: string; materials: string[] }[];
  /** 演示：设备时间回拨（序号仍单调） */
  timeRollback: boolean;
  currentUser: string;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const uuid = () => nanoid(10);

/** 业务键：稳定巡护标识 + 条目类型 + 设备内业务键 */
const businessKey = (patrolId: string, kind: PacketEntryKind, clientKey: string) =>
  `${patrolId}:${kind}:${clientKey}`;

/** 不可改交接段 */
const segment = (
  action: HandoverAction,
  by: string,
  opts: { location?: HandoverSegment['location']; note?: string; at?: string; voided?: boolean } = {}
): HandoverSegment => ({
  id: uuid(),
  action,
  at: opts.at ?? new Date().toLocaleString(),
  by,
  ...(opts.location ? { location: opts.location } : {}),
  ...(opts.note ? { note: opts.note } : {}),
  immutable: true,
  ...(opts.voided ? { voided: true } : {})
});

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** 两点距离（km），简易球面距离 */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------------------
// 种子数据（含升级后的旧记录：只有采集人和时间）
// ---------------------------------------------------------------------------
function seedState(): State {
  const deviceId = `dev-${uuid()}`;
  const patrolId = `patrol-${uuid()}`;
  const now = new Date();
  const legacyTime = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3).toLocaleString();
  return {
    deviceId,
    patrolId,
    deviceSeq: 0,
    currentUser: '巡护员·扎西',
    reviewer: {
      name: '负责人·卓玛',
      maxRisk: 'medium',
      area: { lat: 30.58, lng: 103.21, radiusKm: 5 }
    },
    packets: [],
    observations: [
      {
        id: 'o1',
        clientKey: 'legacy-o1',
        patrolId: 'legacy',
        deviceId: 'legacy',
        time: legacyTime,
        note: '东坡发现新鲜足迹，沿溪谷方向移动',
        risk: 'medium',
        sync: 'synced',
        reviewed: false,
        evidence: '现场照片-001'
      },
      {
        id: 'o2',
        clientKey: 'legacy-o2',
        patrolId: 'legacy',
        deviceId: 'legacy',
        time: legacyTime,
        note: '红外相机外壳松动，已拍照待补报',
        risk: 'high',
        sync: 'queued',
        reviewed: false
      }
    ],
    points: [
      { id: 'p1', clientKey: 'legacy-p1', patrolId: 'legacy', deviceId: 'legacy', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
      { id: 'p2', clientKey: 'legacy-p2', patrolId: 'legacy', deviceId: 'legacy', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
    ],
    samples: [
      // 旧记录升级：只有采集人和时间，交接链仅采集段，仍可查看和交接
      {
        id: 's-legacy',
        clientKey: 'legacy-s1',
        patrolId: 'legacy',
        deviceId: 'legacy',
        code: 'WD-OLD-01',
        species: '疑似岩羊毛发',
        count: 1,
        status: 'collected',
        collector: '老巡护员·多吉',
        createdAt: legacyTime,
        legacy: true,
        handovers: [segment('collected', '老巡护员·多吉', { at: legacyTime, location: { lat: 30.581, lng: 103.216 } })]
      },
      {
        id: 's1',
        clientKey: 'seed-s1',
        patrolId,
        deviceId,
        code: 'WD-0929-01',
        species: '疑似豹猫毛发',
        count: 1,
        status: 'submitted',
        collector: '巡护员·扎西',
        createdAt: new Date(now.getTime() - 1000 * 60 * 60 * 2).toLocaleString(),
        handovers: [
          segment('collected', '巡护员·扎西', { at: '07:10', location: { lat: 30.582, lng: 103.217 } }),
          segment('handed_over', '巡护员·扎西', { at: '08:30' }),
          segment('received', '站点·老李', { at: '08:40' }),
          segment('submitted', '站点·老李', { at: '09:00' })
        ]
      }
    ],
    conflict: null,
    missingMaterials: [],
    timeRollback: false
  };
}

const STORAGE_KEY = 'yf57-patrol-state-v2';

function readState(): State {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as State;
      // 升级兼容：旧记录没有 patrolId/deviceId 也保留（仍可查看、交接）
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return seedState();
}

// ---------------------------------------------------------------------------
// 处理一个巡护包：逐条处理，互不影响；幂等（同包重传沿用第一次结果）
// ---------------------------------------------------------------------------
function processPacket(packet: PatrolPacket, state: State): EntryResult[] {
  // 已处理过的包：重传沿用第一次结果
  if (packet.status === 'processed' && packet.results) return packet.results;

  const results: EntryResult[] = [];
  for (const entry of packet.entries) {
    const bKey = businessKey(packet.patrolId, entry.kind, entry.payload.clientKey ?? entry.key);
    // 业务键去重：观察 / 轨迹 / 样本
    const exists =
      entry.kind === 'observation'
        ? state.observations.some((o) => businessKey(o.patrolId, 'observation', o.clientKey) === bKey)
        : entry.kind === 'point'
          ? state.points.some((p) => businessKey(p.patrolId, 'point', p.clientKey) === bKey)
          : state.samples.some((s) => businessKey(s.patrolId, 'sample', s.clientKey) === bKey);
    if (exists) {
      results.push({ key: entry.key, kind: entry.kind, status: 'duplicate', reason: '业务键重复，已去重' });
      continue;
    }

    // 校验与缺失证据
    const missing: string[] = [];
    let failed = false;
    let failReason = '';
    if (entry.kind === 'observation') {
      const note = String(entry.payload.note ?? '').trim();
      if (note.length < 2) {
        failed = true;
        failReason = '观察内容过短或为空';
      }
      if (!entry.payload.evidence) missing.push('现场照片/证据');
    } else if (entry.kind === 'sample') {
      if (!entry.payload.code) {
        failed = true;
        failReason = '样本编号缺失';
      }
      if (!entry.payload.species) {
        failed = true;
        failReason = failReason || '物种名称缺失';
      }
      if (!entry.payload.location) missing.push('采集位置');
    } else if (entry.kind === 'point') {
      const lat = Number(entry.payload.latitude);
      const lng = Number(entry.payload.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        failed = true;
        failReason = '轨迹点坐标无效';
      }
    }

    if (failed) {
      results.push({ key: entry.key, kind: entry.kind, status: 'failed', reason: failReason, missingMaterials: missing });
      continue;
    }

    // 接收入库
    if (entry.kind === 'observation') {
      state.observations.unshift({
        id: `o-${uuid()}`,
        clientKey: entry.payload.clientKey,
        patrolId: packet.patrolId,
        deviceId: packet.deviceId,
        time: entry.payload.time ?? packet.createdAt,
        note: entry.payload.note,
        risk: entry.payload.risk ?? 'low',
        sync: 'synced',
        reviewed: false,
        evidence: entry.payload.evidence,
        location: entry.payload.location
      });
    } else if (entry.kind === 'point') {
      state.points.push({
        id: `p-${uuid()}`,
        clientKey: entry.payload.clientKey,
        patrolId: packet.patrolId,
        deviceId: packet.deviceId,
        latitude: Number(entry.payload.latitude),
        longitude: Number(entry.payload.longitude),
        at: entry.payload.at ?? packet.createdAt,
        source: entry.payload.source ?? 'gps'
      });
    } else if (entry.kind === 'sample') {
      const collectedAt = entry.payload.collectedAt ?? packet.createdAt;
      state.samples.unshift({
        id: `s-${uuid()}`,
        clientKey: entry.payload.clientKey,
        patrolId: packet.patrolId,
        deviceId: packet.deviceId,
        code: entry.payload.code,
        species: entry.payload.species,
        count: Number(entry.payload.count) || 1,
        status: 'collected',
        collector: entry.payload.collector ?? state.currentUser,
        createdAt: collectedAt,
        handovers: [
          segment('collected', entry.payload.collector ?? state.currentUser, {
            at: collectedAt,
            location: entry.payload.location
          })
        ]
      });
    }
    results.push({ key: entry.key, kind: entry.kind, status: 'accepted', missingMaterials: missing.length ? missing : undefined });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------
const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    /** 开始一次新巡护：稳定巡护标识变化，设备序号继续连续 */
    startPatrol: (state) => {
      state.patrolId = `patrol-${uuid()}`;
    },

    /** 模拟第二台设备：同一巡护标识下拆出另一包（含部分重复业务键） */
    simulateSecondDevice: (state) => {
      const otherDevice = `dev-${uuid()}`;
      const now = state.timeRollback
        ? new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toLocaleString()
        : new Date().toLocaleString();
      state.deviceSeq += 1;
      const packet: PatrolPacket = {
        id: `pkt-${uuid()}`,
        deviceId: otherDevice,
        patrolId: state.patrolId,
        seq: state.deviceSeq,
        createdAt: now,
        status: 'open',
        entries: [
          // 与本机重复的观察（同业务键）→ 应去重
          {
            key: `e-${uuid()}`,
            kind: 'observation',
            payload: { clientKey: 'dup-obs-1', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', evidence: '现场照片-001' }
          },
          // 新观察
          {
            key: `e-${uuid()}`,
            kind: 'observation',
            payload: { clientKey: `obs-${uuid()}`, note: '北坡发现盗猎陷阱痕迹', risk: 'high', evidence: '现场照片-002' }
          },
          // 缺失证据的观察
          { key: `e-${uuid()}`, kind: 'observation', payload: { clientKey: `obs-${uuid()}`, note: '溪流水质变浑', risk: 'low' } },
          // 一条失败样本（缺编号）
          { key: `e-${uuid()}`, kind: 'sample', payload: { clientKey: `smp-${uuid()}`, species: '疑似昆虫样本', count: 1 } },
          // 正常样本
          { key: `e-${uuid()}`, kind: 'sample', payload: { clientKey: `smp-${uuid()}`, code: 'WD-0929-09', species: '疑似鸟类羽毛', count: 2, location: { lat: 30.583, lng: 103.219 } } }
        ]
      };
      state.packets.unshift(packet);
      // 立即处理（模拟联网同步）
      packet.results = processPacket(packet, state);
      packet.status = 'processed';
    },

    /** 记录一条观察（进入当前开包） */
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk; evidence?: string; location?: { lat: number; lng: number } }>) => {
      let open = state.packets.find((p) => p.status === 'open' && p.deviceId === state.deviceId);
      if (!open) {
        state.deviceSeq += 1;
        open = {
          id: `pkt-${uuid()}`,
          deviceId: state.deviceId,
          patrolId: state.patrolId,
          seq: state.deviceSeq,
          createdAt: new Date().toLocaleString(),
          entries: [],
          status: 'open'
        };
        state.packets.unshift(open);
      }
      const clientKey = `obs-${uuid()}`;
      open.entries.push({ key: `e-${uuid()}`, kind: 'observation', payload: { clientKey, time: new Date().toLocaleString(), ...action.payload } });
    },

    /** 记录轨迹点（进入当前开包） */
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      let open = state.packets.find((p) => p.status === 'open' && p.deviceId === state.deviceId);
      if (!open) {
        state.deviceSeq += 1;
        open = {
          id: `pkt-${uuid()}`,
          deviceId: state.deviceId,
          patrolId: state.patrolId,
          seq: state.deviceSeq,
          createdAt: new Date().toLocaleString(),
          entries: [],
          status: 'open'
        };
        state.packets.unshift(open);
      }
      open.entries.push({
        key: `e-${uuid()}`,
        kind: 'point',
        payload: { clientKey: `pt-${uuid()}`, latitude: action.payload.latitude, longitude: action.payload.longitude, at: new Date().toLocaleTimeString() }
      });
    },

    /** 记录样本（进入当前开包） */
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; location?: { lat: number; lng: number } }>) => {
      let open = state.packets.find((p) => p.status === 'open' && p.deviceId === state.deviceId);
      if (!open) {
        state.deviceSeq += 1;
        open = {
          id: `pkt-${uuid()}`,
          deviceId: state.deviceId,
          patrolId: state.patrolId,
          seq: state.deviceSeq,
          createdAt: new Date().toLocaleString(),
          entries: [],
          status: 'open'
        };
        state.packets.unshift(open);
      }
      open.entries.push({
        key: `e-${uuid()}`,
        kind: 'sample',
        payload: { clientKey: `smp-${uuid()}`, collector: state.currentUser, collectedAt: new Date().toLocaleString(), ...action.payload }
      });
    },

    /** 封包并同步（处理当前开包，逐条产出结果） */
    sealAndSync: (state) => {
      const open = state.packets.find((p) => p.status === 'open' && p.deviceId === state.deviceId);
      if (!open) return;
      open.results = processPacket(open, state);
      open.status = 'processed';
      // 汇总待补材料
      for (const r of open.results) {
        if (r.missingMaterials?.length) {
          const entry = open.entries.find((e) => e.key === r.key);
          state.missingMaterials.push({
            observationId: r.kind === 'observation' ? entry?.payload.clientKey : undefined,
            sampleId: r.kind === 'sample' ? entry?.payload.clientKey : undefined,
            materials: r.missingMaterials
          });
        }
      }
    },

    /** 重传：沿用第一次结果（幂等），不重复入库 */
    retransmitPacket: (state, action: PayloadAction<string>) => {
      const packet = state.packets.find((p) => p.id === action.payload);
      if (!packet) return;
      packet.retransmitted = (packet.retransmitted ?? 0) + 1;
      // 已处理过：processPacket 直接返回第一次 results，不重复入库
      packet.results = processPacket(packet, state);
      packet.status = 'processed';
    },

    /** 负责人复核：能力范围 / 位置异常 / 缺失证据 */
    reviewObservation: (state, action: PayloadAction<{ id: string; pass: boolean; note?: string }>) => {
      const obs = state.observations.find((o) => o.id === action.payload.id);
      if (!obs) return;
      const reasons: string[] = [];
      const missing: string[] = [];
      // 能力范围：风险超出负责人可复核上限
      if (RISK_ORDER[obs.risk] > RISK_ORDER[state.reviewer.maxRisk]) {
        reasons.push(`风险等级「${obs.risk === 'high' ? '高' : '中'}」超出负责人能力范围（可复核上限：${state.reviewer.maxRisk === 'medium' ? '中' : '低'}）`);
      }
      // 位置异常：轨迹点远离负责区域
      if (obs.location) {
        const d = distanceKm(obs.location, state.reviewer.area);
        if (d > state.reviewer.area.radiusKm) {
          reasons.push(`位置异常：距负责区域约 ${d.toFixed(1)} km（半径 ${state.reviewer.area.radiusKm} km）`);
        }
      }
      // 缺失证据
      if (!obs.evidence) missing.push('现场照片/证据');
      if (!obs.note || obs.note.trim().length < 2) missing.push('完整观察记录');

      const pass = action.payload.pass && reasons.length === 0 && missing.length === 0;
      obs.reviewed = true;
      obs.review = {
        pass,
        at: new Date().toLocaleString(),
        by: state.reviewer.name,
        reasons,
        missingMaterials: missing
      };
      if (!pass) {
        state.missingMaterials.push({ observationId: obs.clientKey, materials: missing.length ? missing : ['补充说明材料'] });
      }
    },

    /** 样本交接：追加不可改段 */
    advanceSample: (state, action: PayloadAction<{ id: string; action: HandoverAction; note?: string }>) => {
      const sample = state.samples.find((s) => s.id === action.payload.id);
      if (!sample) return;
      const by =
        action.payload.action === 'handed_over'
          ? state.currentUser
          : action.payload.action === 'verified'
            ? state.reviewer.name
            : '站点·老李';
      sample.handovers.push(segment(action.payload.action, by, { note: action.payload.note }));
      if (action.payload.action === 'collected') sample.status = 'collected';
      else if (action.payload.action === 'handed_over') sample.status = 'in_transit';
      else if (action.payload.action === 'received') sample.status = 'received';
      else if (action.payload.action === 'submitted') sample.status = 'submitted';
      else if (action.payload.action === 'verified') sample.status = 'verified';
      else if (action.payload.action === 'supplemented') {
        // 补齐后从退回点继续
        sample.status = sample.resumeStage ?? 'in_transit';
      }
    },

    /** 退回样本：只作废受影响样本的后续交接段 */
    rejectSample: (state, action: PayloadAction<{ id: string; reason: string }>) => {
      const sample = state.samples.find((s) => s.id === action.payload.id);
      if (!sample) return;
      // 退回点 = 当前阶段对应段（最后一个未作废的同名段）
      const stageToAction: Record<string, HandoverAction> = {
        collected: 'collected',
        in_transit: 'handed_over',
        received: 'received',
        submitted: 'submitted'
      };
      const rejectAt = stageToAction[sample.status];
      let cutoff = -1;
      for (let i = sample.handovers.length - 1; i >= 0; i--) {
        if (sample.handovers[i].action === rejectAt && !sample.handovers[i].voided) {
          cutoff = i;
          break;
        }
      }
      if (cutoff < 0) cutoff = sample.handovers.length - 1;
      // 只作废退回点之后的正向交接段（rejected / supplemented 审计段保留不动）
      const forward: HandoverAction[] = ['handed_over', 'received', 'submitted', 'verified'];
      sample.handovers.forEach((h, idx) => {
        if (idx > cutoff && forward.includes(h.action) && !h.voided) h.voided = true;
      });
      sample.handovers.push(segment('rejected', state.reviewer.name, { note: action.payload.reason }));
      sample.rejectReason = action.payload.reason;
      sample.resumeStage = sample.status; // 从退回点继续
      sample.status = 'rejected';
    },

    /** 补齐材料：追加补齐段，从退回点继续 */
    supplementSample: (state, action: PayloadAction<{ id: string; note: string }>) => {
      const sample = state.samples.find((s) => s.id === action.payload.id);
      if (!sample) return;
      sample.handovers.push(segment('supplemented', state.currentUser, { note: action.payload.note }));
      sample.status = sample.resumeStage ?? 'in_transit';
      sample.rejectReason = undefined;
    },

    /** 演示：切换设备时间回拨（序号仍按设备内顺序） */
    toggleTimeRollback: (state) => {
      state.timeRollback = !state.timeRollback;
    },

    /** 记录级冲突处理（保留本地 / 合并云端） */
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => (item.sync === 'conflict' ? { ...item, sync: 'synced' } : item));
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) })
});

export const { useConnectionQuery } = patrolApi;
export const {
  startPatrol,
  simulateSecondDevice,
  addObservation,
  addPoint,
  addSample,
  sealAndSync,
  retransmitPacket,
  reviewObservation,
  advanceSample,
  rejectSample,
  supplementSample,
  toggleTimeRollback,
  resolveConflict
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol));
  });
}

export type RootState = ReturnType<typeof store.getState>;
