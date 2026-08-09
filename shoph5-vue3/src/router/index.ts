import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/profile',
    },
    {
      path: '/profile',
      component: () => import('../views/ProfileEdit.vue'),
      meta: { title: '个人信息' },
    },
  ],
})

// 添加路由守卫以变更标题
router.beforeEach((to, from, next) => {
  // 如果路由配置了 meta.title，则设置文档标题
  if (to.meta.title) {
    document.title = to.meta.title as string
  }
  next() // 继续导航
})

export default router
