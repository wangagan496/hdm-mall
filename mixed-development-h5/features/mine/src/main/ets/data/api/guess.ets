import { GoodsItems } from 'models'
import { RequestAxios } from 'network'

interface GuessLikeParams {
  page: number
}

// 猜你喜欢分页数据，供个人中心的 HDMGuess 组件通过 loader 注入使用
export const getGuessLikeAPI = (page: number) => {
  return RequestAxios.get<GoodsItems>('/home/goods/guessLike', { page } as GuessLikeParams)
}
