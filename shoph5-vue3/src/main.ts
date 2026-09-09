// Vant 样式先于主题加载，确保 main.css 的令牌能覆盖 Vant 的默认变量
import 'vant/lib/index.css'

import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import {
  Button,
  Cell,
  CellGroup,
  Image,
  Field,
  ActionSheet,
  RadioGroup,
  Radio,
  DatePicker,
  Popup,
  Picker,
  Area,
  Icon,
  SwipeCell,
  Checkbox,
  Popover,
  PullRefresh,
  Empty,
  Skeleton,
  NoticeBar,
} from 'vant'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(Button)
app.use(Cell)
app.use(CellGroup)
app.use(Image)
app.use(Field)
app.use(ActionSheet)
app.use(RadioGroup)
app.use(Radio)
app.use(DatePicker)
app.use(Popup)
app.use(Picker)
app.use(Area)
app.use(Icon)
app.use(SwipeCell)
app.use(Checkbox)
app.use(Popover)
app.use(PullRefresh)
app.use(Empty)
app.use(Skeleton)
app.use(NoticeBar)

app.mount('#app')
