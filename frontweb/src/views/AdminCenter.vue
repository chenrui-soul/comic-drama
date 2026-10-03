<template>
  <main class="admin-page">
    <header class="admin-header">
      <div class="admin-title">
        <el-button text @click="router.push('/')">← 返回项目</el-button>
        <div>
          <h1>管理平台</h1>
          <p>平台公告与用户权限管理</p>
        </div>
      </div>
      <AccountMenu />
    </header>
    <div class="admin-layout">
      <nav class="admin-nav" aria-label="管理功能">
        <span class="nav-label">管理功能</span>
        <RouterLink to="/admin/announcements">平台公告</RouterLink>
        <RouterLink to="/admin/users">用户列表</RouterLink>
      </nav>
      <section class="admin-view" aria-label="管理内容">
        <RouterView />
      </section>
    </div>
  </main>
</template>

<script setup>
import { useRouter } from 'vue-router'
import AccountMenu from '@/components/AccountMenu.vue'

const router = useRouter()
</script>

<style scoped>
.admin-page{min-height:100vh;background:var(--el-bg-color-page);color:var(--el-text-color-primary)}
.admin-header{height:76px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;gap:24px;background:var(--el-bg-color);border-bottom:1px solid var(--el-border-color-lighter)}
.admin-title{display:flex;align-items:center;gap:28px}.admin-title>div{display:flex;align-items:baseline;gap:12px}
h1{font-size:20px;margin:0}.admin-title p{margin:0;color:var(--el-text-color-secondary);font-size:13px}
.admin-layout{max-width:1440px;min-height:calc(100vh - 76px);margin:0 auto;padding:28px;display:grid;grid-template-columns:210px minmax(0,1fr);gap:32px}
.admin-nav{display:flex;flex-direction:column;align-items:stretch;gap:4px;padding-right:20px;border-right:1px solid var(--el-border-color-lighter)}
.nav-label{padding:8px 12px;color:var(--el-text-color-secondary);font-size:12px}
.admin-nav a{padding:10px 12px;border-radius:6px;color:var(--el-text-color-regular);text-decoration:none;font-size:14px}
.admin-nav a:hover{background:var(--el-fill-color-light);color:var(--el-color-primary)}
.admin-nav a.router-link-active{background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-weight:600}
.admin-view{min-width:0}
@media(max-width:700px){.admin-header{height:auto;min-height:68px;padding:12px 14px;flex-wrap:wrap}.admin-title{gap:10px}.admin-title>div{display:block}.admin-title p{display:none}.admin-layout{min-height:calc(100vh - 68px);padding:16px 14px;grid-template-columns:1fr;gap:20px}.admin-nav{flex-direction:row;padding:0 0 10px;border-right:0;border-bottom:1px solid var(--el-border-color-lighter)}.nav-label{display:none}.admin-nav a{flex:1;text-align:center;padding:9px 6px}}
</style>
