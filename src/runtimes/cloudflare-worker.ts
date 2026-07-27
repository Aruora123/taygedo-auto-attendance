import { loadRuntimeConfig } from '../config/runtime.js'
import { AttendanceService } from '../services/attendance-service.js'
import { LoginService } from '../services/login-service.js'
import { createCloudflareAccountStore, createCloudflareStateStore } from '../stores/cloudflare-factory.js'
import { cloudflareUserCenterFetch } from './cloudflare-http1.js'
import { TaygedoApi } from '../taygedo/api.js'
import { generateDeviceIdentity } from '../taygedo/device.js'
import type { LoginActionDependencies } from '../login-action.js'

type ScheduledController = Record<string, unknown>
type ExecutionContext = Record<string, unknown>

interface CloudflareEnv extends Record<string, unknown> {
  KV: {
    get(key: string): Promise<string | null>
    put(key: string, value: string): Promise<void>
  }
  TAYGEDO_TEST_API?: ConstructorParameters<typeof AttendanceService>[0]['api']
  TAYGEDO_TEST_LOGIN_API?: LoginActionDependencies['api']
}

const worker = {
  async scheduled(_event: ScheduledController, env: CloudflareEnv, _ctx: ExecutionContext): Promise<void> {
    await runCloudflareAttendance(env)
  },

  async fetch(request: Request, env: CloudflareEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/') {
      return htmlResponse(renderManagementPage())
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }
    if (url.pathname !== '/run' && url.pathname !== '/login') {
      return Response.json({ error: '未找到' }, { status: 404 })
    }

    const config = loadRuntimeConfig(envToStrings(env))
    if (config.adminToken && !constantTimeTokenMatches(`Bearer ${config.adminToken}`, request.headers.get('Authorization'))) {
      return Response.json({ error: '未授权' }, { status: 401 })
    }

    try {
      if (url.pathname === '/login') {
        const result = await runCloudflareLogin(request, env)
        return Response.json({ ok: true, ...result })
      }
    }
    catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status })
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[taygedo-login] ${message}`)
      return Response.json({
        error: message,
      }, { status: 502 })
    }

    if (url.pathname === '/run') {
      const result = await runCloudflareAttendance(env, isForceRunRequest(url))
      return Response.json({ ok: true, summary: result.summary, forceRun: result.forceRun })
    }

    return Response.json({ error: '未找到' }, { status: 404 })
  },
}

export default worker

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function renderManagementPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>塔吉多登录</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --ink: #17211b;
      --muted: #647067;
      --line: #d9ded8;
      --accent: #16735f;
      --accent-dark: #0f5b4b;
      --danger: #a43b3b;
      --ok: #1f7a45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 34px); letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
    p { margin: 6px 0 0; color: var(--muted); }
    button, input, textarea {
      font: inherit;
      border-radius: 7px;
      border: 1px solid var(--line);
    }
    button {
      min-height: 38px;
      padding: 0 13px;
      border-color: var(--accent);
      background: var(--accent);
      color: white;
      cursor: pointer;
    }
    button.secondary { background: white; color: var(--accent-dark); border-color: var(--line); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    input, select {
      width: 100%;
      background: white;
      color: var(--ink);
      padding: 9px 10px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    label span { color: var(--muted); }
    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    section {
      margin-top: 20px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .stack { display: grid; gap: 14px; }
    .result {
      min-height: 54px;
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 7px;
      background: #f0f4f1;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--muted);
    }
    .ok { color: var(--ok); }
    .error { color: var(--danger); }
    .hidden { display: none; }
    @media (max-width: 820px) {
      main { width: min(100% - 20px, 640px); padding-top: 18px; }
      header { align-items: start; flex-direction: column; }
      .fields { grid-template-columns: 1fr; }
      section { padding: 14px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>塔吉多登录</h1>
        <p>Cloudflare Worker 专用登录页，用于把账号写入 KV。</p>
      </div>
    </header>

    <section>
      <form id="login-form" class="stack">
        <div class="fields">
          <label><span>管理员 Token</span><input id="token" type="password" autocomplete="current-password" required></label>
          <label><span>登录方式</span>
            <select id="mode" name="mode">
              <option value="password">账号密码登录</option>
              <option value="captcha">短信验证码登录</option>
            </select>
          </label>
          <label><span>手机号</span><input id="phone" name="phone" inputmode="tel" autocomplete="tel" required></label>
          <label class="password-field"><span>密码</span><input id="password" name="password" type="password" autocomplete="current-password"></label>
          <label class="captcha-field hidden"><span>短信验证码</span><input id="captcha" name="captcha" inputmode="numeric" autocomplete="one-time-code"></label>
          <label><span>账号 ID</span><input id="account-id" name="accountId" value="main"></label>
          <label><span>账号名称</span><input id="account-name" name="accountName" value="主账号"></label>
        </div>
        <div class="toolbar">
          <button id="submit" type="submit">账号密码登录</button>
          <button id="remember" class="secondary" type="button">记住 Token</button>
        </div>
      </form>
      <div id="result" class="result">请选择登录模式后提交。</div>
    </section>
  </main>

  <script>
    const form = document.querySelector('#login-form')
    const modeInput = document.querySelector('#mode')
    const tokenInput = document.querySelector('#token')
    const phoneInput = document.querySelector('#phone')
    const captchaInput = document.querySelector('#captcha')
    const submitButton = document.querySelector('#submit')
    const result = document.querySelector('#result')
    const captchaSessionKey = 'taygedoCaptchaSession'
    const captchaSessionTtlMs = 10 * 60 * 1000
    const captchaResendSeconds = 60
    let captchaDeviceId = ''
    let captchaPhone = ''
    let captchaSentAt = 0
    let resendTimer = 0
    let captchaExpiryTimer = 0
    let resendRemaining = 0
    let sendingCaptcha = false
    tokenInput.value = localStorage.getItem('taygedoAdminToken') || ''

    function syncMode() {
      const mode = modeInput.value
      const captchaMode = mode === 'captcha'
      document.querySelector('.password-field').classList.toggle('hidden', captchaMode)
      document.querySelector('.captcha-field').classList.toggle('hidden', !captchaMode)
      document.querySelector('#password').required = !captchaMode
      captchaInput.required = false
      syncSubmitButton()
    }

    function clearStoredCaptchaSession() {
      try {
        sessionStorage.removeItem(captchaSessionKey)
      } catch {}
    }

    function resetCaptchaSession() {
      captchaDeviceId = ''
      captchaPhone = ''
      captchaSentAt = 0
      resendRemaining = 0
      if (resendTimer) window.clearInterval(resendTimer)
      if (captchaExpiryTimer) window.clearTimeout(captchaExpiryTimer)
      resendTimer = 0
      captchaExpiryTimer = 0
      clearStoredCaptchaSession()
    }

    function hasCaptchaSession() {
      if (!captchaDeviceId || captchaPhone !== phoneInput.value.trim()) return false
      const age = Date.now() - captchaSentAt
      if (!captchaSentAt || age < 0 || age >= captchaSessionTtlMs) {
        resetCaptchaSession()
        return false
      }
      return true
    }

    function syncSubmitButton() {
      if (modeInput.value !== 'captcha') {
        submitButton.textContent = '账号密码登录'
        return
      }
      if (sendingCaptcha) {
        submitButton.textContent = '正在发送验证码...'
        return
      }
      if (!hasCaptchaSession()) {
        submitButton.textContent = '发送验证码'
        return
      }
      submitButton.textContent = !captchaInput.value.trim() && resendRemaining <= 0
        ? '重新发送验证码'
        : '验证码登录'
    }

    function startResendCooldown(seconds) {
      if (resendTimer) window.clearInterval(resendTimer)
      resendRemaining = seconds
      syncSubmitButton()
      resendTimer = window.setInterval(() => {
        resendRemaining -= 1
        if (resendRemaining <= 0) {
          window.clearInterval(resendTimer)
          resendTimer = 0
          resendRemaining = 0
        }
        syncSubmitButton()
      }, 1000)
    }

    function scheduleCaptchaExpiry() {
      if (captchaExpiryTimer) window.clearTimeout(captchaExpiryTimer)
      const remaining = captchaSentAt + captchaSessionTtlMs - Date.now()
      if (remaining <= 0) {
        resetCaptchaSession()
        return
      }
      captchaExpiryTimer = window.setTimeout(() => {
        resetCaptchaSession()
        result.className = 'result error'
        result.textContent = '验证码已过期，请重新发送。'
        syncSubmitButton()
      }, remaining)
    }

    function persistCaptchaSession() {
      try {
        sessionStorage.setItem(captchaSessionKey, JSON.stringify({
          deviceId: captchaDeviceId,
          phone: captchaPhone,
          sentAt: captchaSentAt,
        }))
      } catch {}
      scheduleCaptchaExpiry()
    }

    function restoreCaptchaSession() {
      let stored = ''
      try {
        stored = sessionStorage.getItem(captchaSessionKey) || ''
      } catch {}
      if (!stored) return false

      try {
        const parsed = JSON.parse(stored)
        const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : ''
        const phone = typeof parsed.phone === 'string' ? parsed.phone : ''
        const sentAt = Number(parsed.sentAt)
        const age = Date.now() - sentAt
        if (!deviceId || !phone || !Number.isFinite(sentAt) || age < 0 || age >= captchaSessionTtlMs) {
          clearStoredCaptchaSession()
          return false
        }

        captchaDeviceId = deviceId
        captchaPhone = phone
        captchaSentAt = sentAt
        phoneInput.value = phone
        modeInput.value = 'captcha'
        const cooldownRemaining = Math.ceil((sentAt + captchaResendSeconds * 1000 - Date.now()) / 1000)
        if (cooldownRemaining > 0) startResendCooldown(cooldownRemaining)
        scheduleCaptchaExpiry()
        result.className = 'result ok'
        result.textContent = '已恢复刚才发送的验证码，可继续填写并登录。'
        return true
      } catch {
        clearStoredCaptchaSession()
        return false
      }
    }

    function payloadFromForm(modeOverride) {
      const data = new FormData(form)
      const uiMode = String(data.get('mode') || 'password')
      const mode = modeOverride || (uiMode === 'captcha' ? 'login' : 'password')
      const payload = {
        mode,
        phone: String(data.get('phone') || '').trim(),
        accountId: String(data.get('accountId') || 'main').trim() || 'main',
        accountName: String(data.get('accountName') || '').trim() || '主账号',
      }
      const password = String(data.get('password') || '')
      const captcha = String(data.get('captcha') || '').trim()
      if (mode === 'password') payload.password = password
      if (mode === 'login') {
        payload.captcha = captcha
        payload.deviceId = captchaDeviceId || undefined
      }
      return payload
    }

    async function requestLogin(payload) {
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer ' + tokenInput.value.trim(),
        },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP 状态码 ' + response.status)
      return data
    }

    async function sendCaptcha() {
      const requestedPhone = phoneInput.value.trim()
      result.className = 'result'
      result.textContent = '正在发送验证码...'
      sendingCaptcha = true
      submitButton.disabled = true
      syncSubmitButton()
      try {
        const payload = payloadFromForm('send-code')
        const data = await requestLogin(payload)
        if (!data.deviceId) throw new Error('发送验证码后未返回设备信息，请重试。')
        captchaDeviceId = data.deviceId
        captchaPhone = payload.phone
        captchaSentAt = Date.now()
        persistCaptchaSession()
        result.className = 'result ok'
        result.textContent = '验证码已发送，请在上方填写短信验证码并登录。'
        startResendCooldown(captchaResendSeconds)
        captchaInput.focus()
      } catch (error) {
        const hasUsableSession = Boolean(captchaDeviceId && captchaPhone === requestedPhone)
        if (!hasUsableSession) resetCaptchaSession()
        result.className = 'result error'
        result.textContent = error.message + (hasUsableSession ? '；刚才成功发送的验证码仍可继续登录。' : '')
      } finally {
        sendingCaptcha = false
        submitButton.disabled = false
        syncSubmitButton()
      }
    }

    async function submitLogin(event) {
      event.preventDefault()
      if (modeInput.value === 'captcha') {
        if (!hasCaptchaSession()) {
          await sendCaptcha()
          return
        }
        if (!captchaInput.value.trim()) {
          if (resendRemaining <= 0) {
            await sendCaptcha()
            return
          }
          result.className = 'result error'
          result.textContent = '请输入短信验证码；' + resendRemaining + ' 秒后可重新发送。'
          captchaInput.focus()
          return
        }
      }
      result.className = 'result'
      result.textContent = '正在提交...'
      submitButton.disabled = true
      try {
        await requestLogin(payloadFromForm())
        resetCaptchaSession()
        result.className = 'result ok'
        result.textContent = '登录成功，账号已写入 KV。'
      } catch (error) {
        result.className = 'result error'
        result.textContent = error.message
      } finally {
        submitButton.disabled = false
        syncSubmitButton()
      }
    }

    document.querySelector('#remember').addEventListener('click', () => {
      localStorage.setItem('taygedoAdminToken', tokenInput.value)
      result.className = 'result ok'
      result.textContent = 'Token 已保存在当前浏览器。'
    })
    modeInput.addEventListener('change', () => {
      resetCaptchaSession()
      captchaInput.value = ''
      syncMode()
    })
    phoneInput.addEventListener('input', () => {
      if (captchaPhone && captchaPhone !== phoneInput.value.trim()) {
        resetCaptchaSession()
      }
      syncSubmitButton()
    })
    captchaInput.addEventListener('input', syncSubmitButton)
    form.addEventListener('submit', submitLogin)
    restoreCaptchaSession()
    syncMode()
  </script>
</body>
</html>`
}

async function runCloudflareAttendance(env: CloudflareEnv, forceRun?: boolean) {
  const config = loadRuntimeConfig(envToStrings(env))
  const service = new AttendanceService({
    accountStore: createCloudflareAccountStore({ config, kv: env.KV }),
    stateStore: createCloudflareStateStore({ config, kv: env.KV }),
    api: env.TAYGEDO_TEST_API ?? createCloudflareTaygedoApi(),
    accountPasswords: config.accountPasswords,
    credentialKey: config.credentialKey,
    notificationUrls: config.notificationUrls,
    maxRetries: config.maxRetries,
    accountConcurrency: config.accountConcurrency,
    forceRun: forceRun ?? config.forceRun,
    coinTasks: config.coinTasks,
    cloudDuration: config.cloudDuration,
    sharePlatform: config.sharePlatform,
  })
  return await service.run()
}

function isForceRunRequest(url: URL): boolean {
  const value = url.searchParams.get('force')
  return value === '1' || value === 'true'
}

async function runCloudflareLogin(request: Request, env: CloudflareEnv) {
  const config = loadRuntimeConfig(envToStrings(env))
  const body = await readLoginBody(request)
  const mode = body.mode ?? 'password'
  if (mode === 'password' && body.password && !config.credentialKey) {
    throw new HttpError(400, '缺少 TAYGEDO_CREDENTIAL_KEY，请先在 Cloudflare 中添加 Secret。')
  }
  const currentAccounts = await tryReadCloudflareAccounts(env, config.accountsKey, config.accountsSecret)
  const service = new LoginService({
    api: env.TAYGEDO_TEST_LOGIN_API ?? createCloudflareTaygedoApi(),
    onStage: (stage, details) => {
      console.info(`[taygedo-login] stage=${stage} ${JSON.stringify(details)}`)
    },
  })
  const deviceId = body.deviceId ?? (mode === 'send-code' ? generateDeviceIdentity().deviceId : undefined)
  await service.runLogin({
    mode,
    phone: body.phone,
    password: body.password,
    captcha: body.captcha,
    deviceId,
    newDevice: body.newDevice,
    accountId: body.accountId ?? 'main',
    accountName: body.accountName ?? body.accountId ?? '主账号',
    accountsFile: undefined,
    accountsSecret: currentAccounts,
    credentialKey: config.credentialKey,
    writeAccounts: payload => env.KV.put(config.accountsKey, payload),
  })
  return {
    accountId: body.accountId ?? 'main',
    ...(mode === 'send-code' ? { deviceId } : {}),
  }
}

function createCloudflareTaygedoApi(): TaygedoApi {
  return new TaygedoApi({ userCenterFetch: cloudflareUserCenterFetch })
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LoginRequestBody {
  mode?: string
  phone: string
  password?: string
  captcha?: string
  deviceId?: string
  newDevice?: boolean
  accountId?: string
  accountName?: string
}

async function readLoginBody(request: Request): Promise<LoginRequestBody> {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'Cloudflare 登录接口必须使用 POST')
  }
  const body = await request.json() as unknown
  if (!isRecord(body)) {
    throw new HttpError(400, '登录请求必须是 JSON 对象')
  }
  return validateLoginBody(body)
}

async function tryReadCloudflareAccounts(env: CloudflareEnv, key: string, fallback?: string): Promise<string | undefined> {
  return await env.KV.get(key) ?? fallback
}

function envToStrings(env: CloudflareEnv): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {
    TAYGEDO_ACCOUNT_STORE: 'cloudflare-kv',
    TAYGEDO_STATE_STORE: 'cloudflare-kv',
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      values[key] = value
    }
  }
  return values
}

export function constantTimeTokenMatches(expected: string, actual: string | null): boolean {
  const expectedBytes = new TextEncoder().encode(expected)
  const actualBytes = new TextEncoder().encode(actual ?? '')
  const length = Math.max(expectedBytes.length, actualBytes.length)
  let diff = expectedBytes.length ^ actualBytes.length

  for (let index = 0; index < length; index++) {
    diff |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0)
  }

  return diff === 0
}

function validateLoginBody(body: Record<string, unknown>): LoginRequestBody {
  const mode = optionalStringField(body, 'mode') ?? 'password'
  if (mode !== 'password' && mode !== 'send-code' && mode !== 'login') {
    throw new HttpError(400, '登录模式无效')
  }

  const phone = requiredStringField(body, 'phone', 32)
  if (!/^1\d{10}$/.test(phone)) {
    throw new HttpError(400, '登录手机号格式无效')
  }

  const result: LoginRequestBody = { mode, phone }
  const password = optionalStringField(body, 'password', 256, { trim: false })
  if (password !== undefined) {
    result.password = password
  }
  const captcha = optionalStringField(body, 'captcha', 16)
  if (captcha !== undefined) {
    if (!/^\d{4,8}$/.test(captcha)) {
      throw new HttpError(400, '短信验证码格式无效')
    }
    result.captcha = captcha
  }
  const deviceId = optionalStringField(body, 'deviceId', 128)
  if (deviceId !== undefined) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
      throw new HttpError(400, '设备 ID 格式无效')
    }
    result.deviceId = deviceId
  }
  const accountId = optionalStringField(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      throw new HttpError(400, '账号 ID 格式无效')
    }
    result.accountId = accountId
  }
  const accountName = optionalStringField(body, 'accountName', 64)
  if (accountName !== undefined) {
    result.accountName = accountName
  }
  if (body.newDevice !== undefined) {
    if (typeof body.newDevice !== 'boolean') {
      throw new HttpError(400, 'newDevice 必须是布尔值')
    }
    result.newDevice = body.newDevice
  }

  return result
}

function requiredStringField(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalStringField(body, field, maxLength)
  if (value === undefined) {
    throw new HttpError(400, `缺少${field}`)
  }
  return value
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
  maxLength = 128,
  options: { trim?: boolean } = {},
): string | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} 必须是字符串`)
  }
  const trimmed = options.trim === false ? value : value.trim()
  if (trimmed === '') {
    return undefined
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} 过长`)
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
