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
} from 'vant'
import 'vant/lib/index.css'

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

app.mount('#app')
