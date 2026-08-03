<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const urlHint = ref('')
const lastRawLoginInput = ref('')

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

function decodeParam(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  if (!raw)
    return ''
  try {
    return decodeURIComponent(raw)
  }
  catch {
    return raw
  }
}

function looksLikeLoginUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw)
    || /^wss?:\/\//i.test(raw)
    || /[?&](?:code|platform|os|ver)=/i.test(raw)
}

function parseLoginInput(rawInput: string): { code: string, platform: '' | 'qq' | 'wx', os: string, ver: string } {
  const raw = String(rawInput || '').trim()
  const result = { code: raw, platform: '' as '' | 'qq' | 'wx', os: '', ver: '' }
  if (!raw || !looksLikeLoginUrl(raw))
    return result

  try {
    let href = raw
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      href = href.startsWith('/')
        ? `http://127.0.0.1${href}`
        : `http://127.0.0.1/prod/ws?${href.replace(/^\?/, '')}`
    }
    const url = new URL(href)
    const code = decodeParam(url.searchParams.get('code'))
    const platform = decodeParam(url.searchParams.get('platform')).toLowerCase()
    result.os = decodeParam(url.searchParams.get('os'))
    result.ver = decodeParam(url.searchParams.get('ver'))
    if (code)
      result.code = code
    if (platform === 'qq' || platform === 'wx')
      result.platform = platform
    return result
  }
  catch {
    const codeMatch = raw.match(/[?&]code=([^&\s#]+)/i)
    if (codeMatch?.[1])
      result.code = decodeParam(codeMatch[1])
    const platformMatch = raw.match(/[?&]platform=([^&\s#]+)/i)
    if (platformMatch?.[1]) {
      const platform = decodeParam(platformMatch[1]).toLowerCase()
      if (platform === 'qq' || platform === 'wx')
        result.platform = platform
    }
    const osMatch = raw.match(/[?&]os=([^&\s#]+)/i)
    if (osMatch?.[1])
      result.os = decodeParam(osMatch[1])
    const verMatch = raw.match(/[?&]ver=([^&\s#]+)/i)
    if (verMatch?.[1])
      result.ver = decodeParam(verMatch[1])
    return result
  }
}

function refreshUrlHint(rawInput: string) {
  const parsed = parseLoginInput(rawInput)
  if (parsed.platform)
    form.platform = parsed.platform

  const parts: string[] = []
  if (parsed.platform)
    parts.push(`平台 ${parsed.platform === 'wx' ? '微信' : 'QQ'}`)
  if (parsed.os)
    parts.push(`系统 ${parsed.os}`)
  if (parsed.ver)
    parts.push(`版本 ${parsed.ver}`)
  urlHint.value = parts.length
    ? `已从 URL 识别：${parts.join(' / ')}（保存时覆盖系统设置）`
    : ''
  return parsed
}

function onCodeInput(value: string | undefined) {
  const raw = String(value ?? '')
  lastRawLoginInput.value = raw
  if (looksLikeLoginUrl(raw))
    refreshUrlHint(raw)
  else
    urlHint.value = ''
}

async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  const rawInput = String(lastRawLoginInput.value || form.code || '').trim()
  if (!rawInput) {
    errorMessage.value = '请输入 Code 或完整登录 URL'
    return
  }

  const parsed = refreshUrlHint(rawInput)
  const code = parsed.code || rawInput
  // 有 URL 参数时把完整原文交给后端，以便覆盖 os/ver；否则只传 code
  const codeForApi = looksLikeLoginUrl(rawInput) ? rawInput : code
  form.code = code

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')
      && !looksLikeLoginUrl(rawInput)

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code: codeForApi,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code: codeForApi,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

function close() {
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    urlHint.value = ''
    lastRawLoginInput.value = ''
    if (props.editData) {
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-2xl" :style="{ background: 'var(--theme-bg)', boxShadow: 'var(--theme-shadow-lg, 0 8px 32px rgba(0,0,0,0.16))' }">
      <div class="flex items-center justify-between p-4" style="border-bottom: 1px solid color-mix(in srgb, var(--theme-text) 10%, transparent)">
        <h3 class="text-lg font-semibold" style="color: var(--theme-primary, var(--theme-text))">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <div class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空默认账号"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code / 登录 URL"
            placeholder="可粘贴裸 Code，或完整 URL（含 platform/os/ver/code）"
            :rows="3"
            class="farm-input"
            @update:model-value="onCodeInput"
          />
          <p v-if="urlHint" class="text-xs" :style="{ color: 'var(--theme-primary)' }">
            {{ urlHint }}
          </p>

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" class="cartoon-btn" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" class="cartoon-btn" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
