import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog, Tag } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation,
  addPoint,
  addSample,
  advanceSample,
  rejectSample,
  supplementSample,
  reviewObservation,
  sealAndSync,
  retransmitPacket,
  simulateSecondDevice,
  startPatrol,
  toggleTimeRollback,
  resolveConflict,
  type RootState,
  type Sample,
  type HandoverSegment,
  type EntryResult
} from '../../store';
import './index.scss';

const formSchema = z.object({
  note: z.string().min(2, '观察内容至少 2 个字'),
  risk: z.enum(['low', 'medium', 'high']),
  evidence: z.string().optional(),
  species: z.string().optional(),
  count: z.string().optional()
});
type FormValues = z.infer<typeof formSchema>;

const RISK_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' };
const ACTION_LABEL: Record<string, string> = {
  collected: '采集',
  handed_over: '交接',
  received: '接收',
  submitted: '送检',
  verified: '核验',
  rejected: '退回',
  supplemented: '补齐'
};
const RESULT_LABEL: Record<EntryResult['status'], { text: string; cls: string }> = {
  accepted: { text: '已接收', cls: 'ok' },
  duplicate: { text: '重复去重', cls: 'dup' },
  failed: { text: '失败', cls: 'fail' },
  conflict: { text: '冲突', cls: 'conflict' }
};

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', evidence: '', species: '', count: '1' }
  });

  const openPacket = state.packets.find((p) => p.status === 'open' && p.deviceId === state.deviceId);
  const queuedCount = openPacket?.entries.length ?? 0;
  const totalMissing = state.missingMaterials.reduce((n, m) => n + m.materials.length, 0);

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(
      addObservation({
        note: values.note,
        risk: values.risk,
        evidence: values.evidence || undefined,
        location: { lat: 30.582 + Math.random() * 0.01, lng: 103.217 + Math.random() * 0.01 }
      })
    );
    if (values.species) {
      dispatch(
        addSample({
          code: `WD-${Date.now().toString().slice(-5)}`,
          species: values.species,
          count: Number(values.count) || 1,
          location: { lat: 30.582, lng: 103.217 }
        })
      );
    }
    reset();
  };

  const nextSampleAction = (sample: Sample): { action: HandoverSegment['action']; label: string } | null => {
    if (sample.status === 'rejected') return { action: 'supplemented', label: '补齐材料' };
    if (sample.status === 'collected') return { action: 'handed_over', label: '交接给站点' };
    if (sample.status === 'in_transit') return { action: 'received', label: '站点接收' };
    if (sample.status === 'received') return { action: 'submitted', label: '送检' };
    if (sample.status === 'submitted') return { action: 'verified', label: '核验完成' };
    return null;
  };

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / OFFLINE PACKET</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">断网拆包记录、联网幂等同步；交接逐段留痕，退回只作废后续段。</Text>
      </View>

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待封包</Text><Text className="metric warn">{queuedCount}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
        <View><Text>巡护包</Text><Text className="metric">{state.packets.length}</Text></View>
        <View><Text>待补材料</Text><Text className="metric fail">{totalMissing}</Text></View>
      </View>

      {/* 设备与巡护标识 */}
      <View className="card">
        <View className="card-title">设备与巡护标识</View>
        <View className="kv"><Text>设备 ID</Text><Text className="mono">{state.deviceId}</Text></View>
        <View className="kv"><Text>当前巡护 ID</Text><Text className="mono">{state.patrolId}</Text></View>
        <View className="kv"><Text>设备内序号</Text><Text className="mono">{state.deviceSeq}（连续单调）</Text></View>
        <View className="kv"><Text>设备时间</Text><Text className={state.timeRollback ? 'rollback' : ''}>{state.timeRollback ? '已回拨（序号仍按顺序）' : '正常'}</Text></View>
        <View className="row">
          <Button size="mini" onClick={() => dispatch(startPatrol())}>开始新巡护</Button>
          <Button size="mini" onClick={() => dispatch(simulateSecondDevice())}>模拟第二台设备</Button>
          <Button size="mini" onClick={() => dispatch(toggleTimeRollback())}>{state.timeRollback ? '恢复时间' : '模拟时间回拨'}</Button>
        </View>
      </View>

      {/* 现场记录 */}
      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险（至少 2 字）" {...register('note', { required: true, minLength: 2 })} />
          <View className="two">
            <Input className="input" placeholder="证据说明（如 现场照片-003）" {...register('evidence')} />
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
          </View>
          <View className="two">
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
            <View className="risk">
              <Text>风险</Text>
              <select {...register('risk')}>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </View>
          </View>
          <Button className="primary" formType="submit">保存进当前巡护包</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      {/* 同步 */}
      <View className="card">
        <View className="card-title">{t.sync}<Text className="count">{queuedCount} 条待封包</Text></View>
        <Button className="secondary" onClick={() => dispatch(sealAndSync())} disabled={queuedCount === 0}>封包并同步</Button>
        <Text className="hint">封包时按设备内连续序号打包；同包重传沿用第一次结果，不重复入库。</Text>
      </View>

      {state.conflict && (
        <View className="alert conflict">
          <Text>{state.conflict}</Text>
          <View className="alert-actions">
            <Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button>
            <Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button>
          </View>
        </View>
      )}

      {/* 巡护包列表 */}
      <View className="card">
        <View className="card-title">巡护包<Text className="count">{state.packets.length} 包</Text></View>
        {state.packets.length === 0 && <Text className="muted">暂无巡护包，保存记录后封包。</Text>}
        {state.packets.map((pkt) => (
          <View className="packet" key={pkt.id}>
            <View className="packet-head">
              <View>
                <Text className="packet-id">包 {pkt.id}</Text>
                <Text className="muted">设备 {pkt.deviceId} · 巡护 {pkt.patrolId}</Text>
                <Text className="muted">序号 {pkt.seq} · {pkt.createdAt}{state.timeRollback ? '（时间已回拨）' : ''}</Text>
              </View>
              <View className="packet-actions">
                <Tag type={pkt.status === 'processed' ? 'success' : 'warning'}>{pkt.status === 'processed' ? '已处理' : '待封包'}</Tag>
                {pkt.status === 'processed' && (
                  <Button size="mini" onClick={() => dispatch(retransmitPacket(pkt.id))}>
                    重传{pkt.retransmitted ? `（${pkt.retransmitted}）` : ''}
                  </Button>
                )}
              </View>
            </View>
            {/* 逐条结果 */}
            {pkt.results && (
              <View className="results">
                {pkt.results.map((r) => (
                  <View className={`result ${RESULT_LABEL[r.status].cls}`} key={r.key}>
                    <Text className="result-kind">{r.kind === 'observation' ? '观察' : r.kind === 'point' ? '轨迹' : '样本'}</Text>
                    <Text className="result-status">{RESULT_LABEL[r.status].text}</Text>
                    {r.reason && <Text className="result-reason">{r.reason}</Text>}
                    {r.missingMaterials && r.missingMaterials.length > 0 && (
                      <Text className="result-missing">待补：{r.missingMaterials.join('、')}</Text>
                    )}
                  </View>
                ))}
              </View>
            )}
            {pkt.status === 'open' && <Text className="muted">含 {pkt.entries.length} 条，等待封包同步。</Text>}
          </View>
        ))}
      </View>

      {/* 观察记录与复核 */}
      <View className="card">
        <View className="card-title">观察记录与复核</View>
        <ScrollView scrollY className="list">
          {state.observations.map((item) => (
            <View className="observation" key={item.id}>
              <View className="obs-body">
                <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
                <Text className="muted">{item.time} · {item.sync} · 巡护 {item.patrolId === 'legacy' ? '旧记录' : item.patrolId}</Text>
                {item.evidence && <Text className="muted">证据：{item.evidence}</Text>}
                {item.review && (
                  <View className={`review ${item.review.pass ? 'pass' : 'reject'}`}>
                    <Text className="review-result">{item.review.pass ? '复核通过' : '复核退回'} · {item.review.by} · {item.review.at}</Text>
                    {item.review.reasons.map((rs, i) => <Text key={i} className="review-reason">· {rs}</Text>)}
                    {item.review.missingMaterials.length > 0 && <Text className="review-missing">待补：{item.review.missingMaterials.join('、')}</Text>}
                  </View>
                )}
              </View>
              <View className="obs-actions">
                <Button size="mini" disabled={item.reviewed} onClick={() => dispatch(reviewObservation({ id: item.id, pass: true }))}>
                  {item.reviewed ? '已复核' : '复核'}
                </Button>
                {item.reviewed && !item.review?.pass && (
                  <Button size="mini" onClick={() => dispatch(reviewObservation({ id: item.id, pass: true }))}>整改后重审</Button>
                )}
              </View>
            </View>
          ))}
        </ScrollView>
        <Text className="hint">复核按能力范围（风险等级）、位置异常（距负责区域）、缺失证据三项给出结论与待补材料。</Text>
      </View>

      {/* 样本交接链 */}
      <View className="card">
        <View className="card-title">样本交接（逐段留痕，不可改）</View>
        {state.samples.map((sample) => {
          const next = nextSampleAction(sample);
          return (
            <View className="sample" key={sample.id}>
              <View className="sample-head">
                <View>
                  <Text className="sample-code">{sample.code} · {sample.species} × {sample.count}</Text>
                  <Text className="muted">采集人：{sample.collector} · {sample.createdAt}</Text>
                  {sample.legacy && <Tag type="warning">旧记录升级</Tag>}
                  {sample.resumeStage && <Text className="resume">从「{ACTION_LABEL[sample.resumeStage] ?? sample.resumeStage}」继续</Text>}
                </View>
                <Tag type={sample.status === 'verified' ? 'success' : sample.status === 'rejected' ? 'danger' : 'info'}>
                  {ACTION_LABEL[sample.status] ?? sample.status}
                </Tag>
              </View>

              {/* 交接链时间轴 */}
              <View className="chain">
                {sample.handovers.map((h) => (
                  <View key={h.id} className={`chain-seg ${h.voided ? 'voided' : ''} ${h.action === 'rejected' ? 'rejected' : ''} ${h.action === 'supplemented' ? 'supplemented' : ''}`}>
                    <Text className="chain-action">{ACTION_LABEL[h.action] ?? h.action}</Text>
                    <Text className="chain-by">{h.by}</Text>
                    <Text className="chain-at">{h.at}</Text>
                    {h.note && <Text className="chain-note">{h.note}</Text>}
                    {h.voided && <Text className="chain-void">（已作废）</Text>}
                  </View>
                ))}
              </View>

              <View className="sample-actions">
                {next && (
                  <Button size="mini" onClick={() => {
                    if (next.action === 'supplemented') {
                      const note = window.prompt('请输入补齐材料说明', sample.rejectReason ? `已补齐：${sample.rejectReason}` : '已补齐缺失材料');
                      if (note !== null) dispatch(supplementSample({ id: sample.id, note }));
                    } else {
                      dispatch(advanceSample({ id: sample.id, action: next.action }));
                    }
                  }}>{next.label}</Button>
                )}
                {sample.status !== 'rejected' && sample.status !== 'verified' && (
                  <Button size="mini" className="reject-btn" onClick={() => {
                    const reason = window.prompt('退回原因（只作废本样本后续交接段）', '证据不足，待补齐后从退回点继续');
                    if (reason !== null) dispatch(rejectSample({ id: sample.id, reason }));
                  }}>退回</Button>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {/* 待补材料汇总 */}
      {totalMissing > 0 && (
        <View className="card">
          <View className="card-title">待补材料<Text className="count fail">{totalMissing} 项</Text></View>
          {state.missingMaterials.map((m, i) => (
            <View className="missing" key={i}>
              <Text className="muted">{m.observationId ? `观察 ${m.observationId}` : `样本 ${m.sampleId}`}</Text>
              <Text>待补：{m.materials.join('、')}</Text>
            </View>
          ))}
        </View>
      )}

      <NutDialog title="离线说明" content="巡护包带设备内连续序号与稳定巡护标识；重传幂等沿用第一次结果；交接段只追加不可改，退回仅作废后续段。" visible={false} />
    </View>
  );
}
