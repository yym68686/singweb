import { useEffect, useRef, useState } from 'react'
import { EthernetPort, Globe, SquareTerminal, type LucideIcon } from 'lucide-react'
import { ApiError, errorMessage } from '../api/errors'
import type { SshLevel, Target, TargetInput, TargetKind } from '../api/types'
import { sshLevelHint, sshLevelLabel, targetKindHint, targetKindLabel } from '../lib/labels'
import { CodeBlock } from './CodeBlock'
import { Check, Field, Fieldset, TextInput, UnitInput } from './Form'
import { Notice } from './Notice'
import type { MenuItem } from './Menu'
import s from './TargetFields.module.css'

export const targetKinds: TargetKind[] = ['ssh', 'http', 'tcp']

export const targetKindIcon: Record<TargetKind, LucideIcon> = {
  ssh: SquareTerminal,
  http: Globe,
  tcp: EthernetPort,
}

/** “添加目标”“添加规则”菜单里的选项 */
export const targetKindItems: MenuItem<TargetKind>[] = targetKinds.map((k) => ({
  value: k,
  label: targetKindLabel[k],
  description: targetKindHint[k],
  icon: targetKindIcon[k],
}))

/** 表单里的数字和状态码先按字符串保存，交给服务端统一校验 */
export interface TargetDraft {
  kind: TargetKind
  name: string
  timeoutMs: string
  note: string
  /** SSH 和 TCP 探测 */
  host: string
  port: string
  /** SSH 探测 */
  level: SshLevel
  hostKey: string
  /** HTTP 探测 */
  url: string
  expectStatus: string
  keyword: string
}

export function emptyDraft(kind: TargetKind): TargetDraft {
  return {
    kind,
    name: '',
    timeoutMs: '5000',
    note: '',
    host: '',
    port: kind === 'ssh' ? '22' : '',
    level: 'handshake',
    hostKey: '',
    url: '',
    expectStatus: '',
    keyword: '',
  }
}

export function draftOf(t: Target): TargetDraft {
  const d = { ...emptyDraft(t.kind), name: t.name, timeoutMs: String(t.timeoutMs), note: t.note ?? '' }
  switch (t.kind) {
    case 'ssh':
      return { ...d, host: t.host, port: String(t.port), level: t.level, hostKey: t.hostKey }
    case 'tcp':
      return { ...d, host: t.host, port: String(t.port) }
    case 'http':
      return { ...d, url: t.url, expectStatus: t.expectStatus.join(', '), keyword: t.keyword ?? '' }
  }
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v))
const splitList = (v: string) => v.split(/[\s,，、;；]+/).filter(Boolean)

export function inputOf(d: TargetDraft): TargetInput {
  const common = { name: d.name, timeoutMs: num(d.timeoutMs), note: d.note }
  switch (d.kind) {
    case 'ssh':
      return {
        kind: 'ssh',
        ...common,
        host: d.host,
        port: num(d.port),
        level: d.level,
        hostKey: d.level === 'handshake' ? d.hostKey : '',
      }
    case 'tcp':
      return { kind: 'tcp', ...common, host: d.host, port: num(d.port) }
    case 'http':
      return {
        kind: 'http',
        ...common,
        url: d.url,
        expectStatus: splitList(d.expectStatus).map(num),
        keyword: d.keyword.trim() || null,
      }
  }
}

/** 影响探测结果的内容，和服务端判断要不要清掉旧探测记录的依据一致 */
function probeKey(d: TargetDraft): string {
  switch (d.kind) {
    case 'ssh':
      return [d.host.trim(), num(d.port), d.level, d.level === 'handshake' ? d.hostKey.trim() : ''].join('|')
    case 'tcp':
      return [d.host.trim(), num(d.port)].join('|')
    case 'http': {
      const codes = [...new Set(splitList(d.expectStatus).map(num))].sort((a, b) => a - b)
      return [d.url.trim(), codes.join(','), d.keyword.trim()].join('|')
    }
  }
}

/** 改动会不会让之前的探测结果作废 */
export const probeChanged = (a: TargetDraft, b: TargetDraft) => probeKey(a) !== probeKey(b)

function keyscanCommand(d: TargetDraft) {
  const host = d.host.trim() || 'example.com'
  const port = num(d.port)
  const p = Number.isInteger(port) && port !== 22 ? ` -p ${port}` : ''
  return `ssh-keyscan${p} -t ed25519 ${host} | ssh-keygen -lf -`
}

export type FieldErrors = Partial<Record<string, string>>

/** 目标表单的状态：草稿、各字段的错误，以及不属于某个字段的错误 */
export function useTargetDraft(init: () => TargetDraft) {
  const [initial] = useState(init)
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const focusNext = useRef<{ root: HTMLElement; field: string } | null>(null)

  // 等错误信息渲染出来再聚焦：读屏软件读到输入框时，会连同错误一起读出来
  useEffect(() => {
    const f = focusNext.current
    if (!f) return
    focusNext.current = null
    f.root.querySelector<HTMLElement>(`[data-field="${CSS.escape(f.field)}"] :is(input, textarea)`)?.focus()
  }, [errors])

  const update = (patch: Partial<TargetDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setErrors((e) => {
      if (!Object.keys(patch).some((k) => e[k])) return e
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k]
      return next
    })
    setFormError(null)
  }

  /** 保存失败：错误属于表单里的某个字段时标在那里并聚焦过去，否则显示在底部 */
  const fail = (err: unknown, root: HTMLElement) => {
    const msg = errorMessage(err)
    if (err instanceof ApiError && err.field && root.querySelector(`[data-field="${CSS.escape(err.field)}"]`)) {
      focusNext.current = { root, field: err.field }
      setErrors({ [err.field]: msg })
    } else {
      setFormError(`没有保存：${msg}`)
    }
  }

  return { initial, draft, update, errors, formError, fail }
}

const namePlaceholder: Record<TargetKind, string> = {
  ssh: '例如 GitHub SSH',
  http: '例如 OpenAI 接口',
  tcp: '例如东京数据库',
}

const hostPlaceholder: Record<TargetKind, string> = {
  ssh: 'github.com',
  http: '',
  tcp: 'db.example.com',
}

const levels: SshLevel[] = ['banner', 'handshake']

interface TargetFieldsProps {
  draft: TargetDraft
  errors: FieldErrors
  onChange: (patch: Partial<TargetDraft>) => void
}

/** 探测目标的字段，按类型显示；外面由调用方包上 form */
export function TargetFields({ draft, errors, onChange: update }: TargetFieldsProps) {
  const noSpell = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const

  return (
    <div className={s.fields}>
      <div data-field="name">
        <Field label="名称" error={errors.name}>
          {(a) => (
            <TextInput
              {...a}
              value={draft.name}
              maxLength={40}
              placeholder={namePlaceholder[draft.kind]}
              data-autofocus
              onChange={(e) => update({ name: e.target.value })}
            />
          )}
        </Field>
      </div>

      {draft.kind === 'http' ? (
        <>
          <div data-field="url">
            <Field
              label="网址"
              error={errors.url}
              hint="Agent 经过节点请求这个网址，不跟随重定向，也不带任何账号或凭据。"
            >
              {(a) => (
                <TextInput
                  {...a}
                  mono
                  type="url"
                  inputMode="url"
                  value={draft.url}
                  placeholder="https://api.openai.com/v1/models"
                  {...noSpell}
                  onChange={(e) => update({ url: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className={s.expect}>
            <div data-field="expectStatus">
              <Field label="期望的状态码" error={errors.expectStatus} hint="留空表示 200–399，多个用逗号分开。">
                {(a) => (
                  <TextInput
                    {...a}
                    className={s.tabular}
                    inputMode="numeric"
                    value={draft.expectStatus}
                    placeholder="200"
                    onChange={(e) => update({ expectStatus: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <div data-field="keyword">
              <Field
                label="响应里要包含的文字（可选）"
                error={errors.keyword}
                hint="区分大小写，只在响应的前 64 KB 里找。留空表示不检查内容。"
              >
                {(a) => (
                  <TextInput
                    {...a}
                    value={draft.keyword}
                    maxLength={100}
                    {...noSpell}
                    onChange={(e) => update({ keyword: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>
        </>
      ) : (
        <div className={s.address}>
          <div data-field="host">
            <Field label="主机" error={errors.host} hint="域名或 IP，不带用户名、协议和端口。">
              {(a) => (
                <TextInput
                  {...a}
                  mono
                  value={draft.host}
                  placeholder={hostPlaceholder[draft.kind]}
                  {...noSpell}
                  onChange={(e) => update({ host: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div data-field="port">
            <Field label="端口" error={errors.port}>
              {(a) => (
                <TextInput
                  {...a}
                  className={s.tabular}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => update({ port: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>
      )}

      {draft.kind === 'tcp' && (
        <Notice title="TCP 探测主要反映节点本身能不能用">
          很多代理协议在节点真正连上目标之前，就告诉 Agent 已经连上了，所以目标端口被封时 TCP 探测也可能通过。能用 SSH
          或 HTTP 探测的服务，优先用它们。
        </Notice>
      )}

      {draft.kind === 'ssh' && (
        <>
          <Fieldset legend="探测到哪一步" hint="握手包含读取标识。两种都不会登录，也不需要账号或私钥。">
            <div className={s.levels}>
              {levels.map((lv) => (
                <Check
                  key={lv}
                  type="radio"
                  card
                  name="level"
                  label={sshLevelLabel[lv]}
                  aside={lv === 'handshake' ? '推荐' : undefined}
                  description={sshLevelHint[lv]}
                  checked={draft.level === lv}
                  onChange={() => update({ level: lv })}
                />
              ))}
            </div>
          </Fieldset>

          {draft.level === 'handshake' && (
            <div className={s.hostKey}>
              <div data-field="hostKey">
                <Field
                  label="主机密钥指纹（可选）"
                  error={errors.hostKey}
                  hint="留空表示只完成握手、不核对指纹。填写后，指纹对不上就算失败：可能有人在中间拦截，也可能是服务器换了密钥。"
                >
                  {(a) => (
                    <TextInput
                      {...a}
                      mono
                      value={draft.hostKey}
                      placeholder="SHA256:…"
                      {...noSpell}
                      onChange={(e) => update({ hostKey: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <CodeBlock
                title="在可信的网络里运行，复制输出中 SHA256: 开头的一段"
                label="获取主机密钥指纹的命令"
                code={keyscanCommand(draft)}
              />
            </div>
          )}
        </>
      )}

      <div data-field="timeoutMs">
        <Field label="超时" error={errors.timeoutMs} hint="500–30000 ms。超过这个时间还没完成，这一次探测就算失败。">
          {(a) => (
            <UnitInput
              {...a}
              unit="ms"
              min={500}
              max={30000}
              step={500}
              value={draft.timeoutMs}
              onChange={(e) => update({ timeoutMs: e.target.value })}
            />
          )}
        </Field>
      </div>

      <Field label="备注（可选）">
        {(a) => <TextInput {...a} value={draft.note} onChange={(e) => update({ note: e.target.value })} />}
      </Field>
    </div>
  )
}
