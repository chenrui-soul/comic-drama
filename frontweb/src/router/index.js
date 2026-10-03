import { createRouter, createWebHistory } from 'vue-router'
import authApi from '@/api/auth'
import { getAuthToken, saveAuthSession } from '@/utils/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/announcements',
      name: 'announcements',
      component: () => import('@/views/Announcements.vue'),
      props: { readOnly: true },
      meta: { title: '平台公告' }
    },
    {
      path: '/admin',
      component: () => import('@/views/AdminCenter.vue'),
      meta: { title: '管理平台', platformAdmin: true },
      children: [
        { path: '', redirect: '/admin/announcements' },
        {
          path: 'announcements',
          name: 'admin-announcements',
          component: () => import('@/views/Announcements.vue'),
          props: { embedded: true },
          meta: { title: '平台公告' }
        },
        {
          path: 'users',
          name: 'platform-users',
          component: () => import('@/views/PlatformUsers.vue'),
          meta: { title: '用户列表' }
        },
        {
          path: 'system-settings',
          name: 'admin-system-settings',
          component: () => import('@/views/AdminSystemSettings.vue'),
          meta: { title: '系统设置' }
        }
      ]
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/AuthPage.vue'),
      props: { mode: 'login' },
      meta: { title: '登录' }
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/AuthPage.vue'),
      props: { mode: 'register' },
      meta: { title: '注册' }
    },
    {
      path: '/organization',
      name: 'organization',
      component: () => import('@/views/OrganizationSettings.vue'),
      meta: { title: '工作区管理' }
    },
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/FilmList.vue'),
      meta: { title: '项目列表' }
    },
    {
      path: '/drama/:id',
      name: 'drama-detail',
      component: () => import('@/views/DramaDetail.vue'),
      meta: { title: '剧集管理' }
    },
    {
      path: '/film/:id',
      name: 'film',
      component: () => import('@/views/FilmCreate.vue'),
      meta: { title: 'AI 视频生成' }
    },
    {
      path: '/film/:id/canvas',
      name: 'film-canvas',
      component: () => import('@/views/DramaCanvas.vue'),
      meta: { title: '画布模式' }
    },
    {
      path: '/ai-config',
      name: 'ai-config',
      component: () => import('@/views/AiConfig.vue'),
      meta: { title: 'AI 配置' }
    },
    {
      path: '/video-prompt-rules/:id?',
      name: 'video-prompt-rules',
      component: () => import('@/views/VideoPromptRules.vue'),
      meta: { title: '视频提示词规则' }
    },
    {
      path: '/creative-skill-rules/:id?',
      name: 'creative-skill-rules',
      component: () => import('@/views/CreativeSkillRules.vue'),
      meta: { title: '创作 Skill 规则' }
    },
    {
      path: '/free-create',
      name: 'free-create',
      component: () => import('@/views/FreeCreate.vue'),
      meta: { title: '自由创作' }
    },
    {
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: '媒体素材库' }
    }
  ]
})

let mediaSessionToken = ''
router.beforeEach(async (to) => {
  if (to.meta.title) {
    document.title = `${to.meta.title} - 白同学短剧助手`
  }
  const isPublic = to.name === 'login' || to.name === 'register'
  const hasToken = Boolean(getAuthToken())
  if (!isPublic && !hasToken) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (hasToken && mediaSessionToken !== getAuthToken()) {
    try {
      const { user } = await authApi.me()
      mediaSessionToken = getAuthToken()
      saveAuthSession({ token: mediaSessionToken }, user)
    } catch (_) { return { name: 'login' } }
  }
  if (to.meta.platformAdmin) {
    try {
      const { user } = await authApi.me()
      saveAuthSession({ token: getAuthToken() }, user)
      if (!user.is_platform_admin) return { name: 'list' }
    } catch (_) { return { name: 'login' } }
  }
  if (isPublic && hasToken) return { name: 'list' }
  return true
})

export default router
