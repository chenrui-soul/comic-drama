<template>
  <main class="auth-page">
    <section class="auth-showcase">
      <div class="brand-mark">✦</div>
      <p class="eyebrow">LOCALMINIDRAMA PLATFORM</p>
      <h1>把故事，变成<br /><em>可见的世界。</em></h1>
      <p class="showcase-copy">从剧本、角色到分镜和成片，在一个属于你的创作工作区里完成全流程。</p>
      <div class="showcase-line"><span></span><small>AI SHORT DRAMA STUDIO</small></div>
    </section>

    <section class="auth-panel">
      <div class="auth-card">
        <div class="mobile-brand">✦ 白同学短剧助手</div>
        <div class="auth-heading">
          <p class="eyebrow">{{ isLogin ? 'WELCOME BACK' : 'CREATE YOUR WORKSPACE' }}</p>
          <h2>{{ isLogin ? '欢迎回来' : '创建你的账号' }}</h2>
          <p>{{ isLogin ? '登录后继续你的短剧创作。' : '注册后即可拥有独立的创作工作区。' }}</p>
        </div>

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
          <el-form-item v-if="!isLogin" label="显示名称" prop="display_name">
            <el-input v-model="form.display_name" placeholder="例如：张三工作室" size="large" maxlength="80" />
          </el-form-item>
          <el-form-item label="邮箱" prop="email">
            <el-input v-model="form.email" type="email" placeholder="name@example.com" size="large" autocomplete="email" />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input v-model="form.password" type="password" placeholder="至少 8 位字符" size="large" show-password autocomplete="new-password" @keyup.enter="submit" />
          </el-form-item>
          <el-button class="submit-button" type="primary" size="large" native-type="submit" :loading="loading">
            {{ isLogin ? '登录工作区' : '创建账号' }}
          </el-button>
        </el-form>

        <p class="switch-copy">
          {{ isLogin ? '还没有账号？' : '已经有账号？' }}
          <button type="button" @click="switchMode">{{ isLogin ? '立即注册' : '去登录' }}</button>
        </p>
        <p class="security-note">你的工作区数据将按组织隔离保存</p>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import authApi from '@/api/auth'
import { saveAuthSession } from '@/utils/auth'

const props = defineProps({ mode: { type: String, default: 'login' } })
const router = useRouter()
const route = useRoute()
const formRef = ref()
const loading = ref(false)
const isLogin = computed(() => props.mode === 'login')
const form = reactive({ display_name: '', email: '', password: '' })
const rules = {
  display_name: [{ required: true, message: '请输入显示名称', trigger: 'blur' }],
  email: [{ required: true, message: '请输入邮箱', trigger: 'blur' }, { type: 'email', message: '邮箱格式不正确', trigger: ['blur', 'change'] }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }, { min: 8, message: '密码至少 8 位', trigger: 'blur' }],
}

function switchMode() {
  router.replace({ name: isLogin.value ? 'register' : 'login', query: route.query })
}

async function submit() {
  if (!formRef.value || loading.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    const result = isLogin.value
      ? await authApi.login({ email: form.email, password: form.password })
      : await authApi.register(form)
    saveAuthSession(result.session, result.user)
    ElMessage.success(isLogin.value ? '登录成功' : '账号创建成功')
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/'
    await router.replace(redirect)
  } catch (_) {
    // request 拦截器已展示后端错误信息
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.auth-page { min-height: 100vh; display: grid; grid-template-columns: minmax(360px, 0.9fr) minmax(420px, 1.1fr); background: #111116; color: #f4f4f5; }
.auth-showcase { position: relative; display: flex; flex-direction: column; justify-content: center; padding: 72px clamp(40px, 8vw, 140px); overflow: hidden; background: radial-gradient(circle at 20% 20%, rgba(124,58,237,.22), transparent 42%), linear-gradient(145deg, #19151f, #111116 62%); }
.auth-showcase::after { content: ''; position: absolute; width: 480px; height: 480px; right: -220px; bottom: -220px; border: 1px solid rgba(196,181,253,.16); border-radius: 50%; box-shadow: 0 0 0 52px rgba(196,181,253,.03), 0 0 0 104px rgba(196,181,253,.02); }
.brand-mark { width: 44px; height: 44px; display: grid; place-items: center; margin-bottom: 40px; border: 1px solid rgba(196,181,253,.45); border-radius: 14px; color: #c4b5fd; font-size: 24px; }
.eyebrow { margin: 0 0 16px; color: #a78bfa; font-size: 11px; letter-spacing: .22em; font-weight: 700; }
h1 { margin: 0; font-size: clamp(40px, 5vw, 74px); line-height: 1.05; letter-spacing: -.05em; font-weight: 600; }
h1 em { color: #c4b5fd; font-style: normal; }
.showcase-copy { max-width: 390px; margin: 30px 0 56px; color: #a1a1aa; font-size: 15px; line-height: 1.8; }
.showcase-line { display: flex; align-items: center; gap: 14px; color: #71717a; font-size: 10px; letter-spacing: .18em; }
.showcase-line span { width: 48px; height: 1px; background: #8b5cf6; }
.auth-panel { display: grid; place-items: center; padding: 44px; background: #f7f7f8; color: #18181b; }
.auth-card { width: min(100%, 410px); padding: 20px 0; }
.mobile-brand { display: none; }
.auth-heading { margin-bottom: 32px; }
.auth-heading .eyebrow { color: #7c3aed; margin-bottom: 12px; }
h2 { margin: 0 0 8px; color: #18181b; font-size: 32px; letter-spacing: -.04em; }
.auth-heading p:last-child { margin: 0; color: #71717a; font-size: 14px; }
:deep(.el-form-item__label) { color: #3f3f46; font-size: 13px; font-weight: 600; }
:deep(.el-input__wrapper) { min-height: 46px; border-radius: 10px; background: #fff; box-shadow: 0 0 0 1px #e4e4e7; }
:deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 2px #a78bfa; }
.submit-button { width: 100%; height: 48px; margin-top: 10px; border: 0; border-radius: 10px; background: linear-gradient(135deg, #7c3aed, #5b21b6); font-weight: 600; }
.switch-copy { margin: 28px 0 0; color: #71717a; text-align: center; font-size: 13px; }
.switch-copy button { padding: 0; border: 0; background: transparent; color: #7c3aed; cursor: pointer; font-weight: 700; }
.security-note { margin: 56px 0 0; color: #a1a1aa; text-align: center; font-size: 11px; }
@media (max-width: 800px) { .auth-page { display: block; background: #f7f7f8; } .auth-showcase { display: none; } .auth-panel { min-height: 100vh; padding: 28px 24px; } .mobile-brand { display: block; margin-bottom: 68px; color: #7c3aed; font-size: 13px; font-weight: 700; letter-spacing: .04em; } .auth-card { max-width: 430px; } }
</style>
