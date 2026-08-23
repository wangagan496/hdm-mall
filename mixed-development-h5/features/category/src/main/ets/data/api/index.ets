import { RequestAxios } from 'network'
import { CategoryItem } from 'models'

export const getCategoryTopAPI = async (): Promise<CategoryItem[]> => {
  const categories = await RequestAxios.get<CategoryItem[]>('/category/top')
  categories.forEach((category: CategoryItem) => {
    category.children = (category.children || []).filter((child) => {
      return child.goods === undefined || child.goods.length > 0
    })
  })
  return categories.filter((category: CategoryItem) => {
    return (category.children || []).length > 0
  })
}
