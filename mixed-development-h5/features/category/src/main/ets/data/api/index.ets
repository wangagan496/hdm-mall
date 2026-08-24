import { RequestAxios } from 'network'
import { CategoryItem, GoodsItems, HDMGoodsItem } from 'models'

interface StorageBagSearchResult {
  pageData: GoodsItems
}

interface StorageBagSearchParams {
  keyword: string
  sortField: string
  sortMethod: string
  page: number
  pageSize: number
}

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

export function findStorageBagPicture(items: HDMGoodsItem[]): ResourceStr {
  const storageBag: HDMGoodsItem | undefined = items.find((item: HDMGoodsItem): boolean => {
    return item.name.includes('收纳包')
  })
  return storageBag ? storageBag.picture : ''
}

export const getStorageBagPictureAPI = async (): Promise<ResourceStr> => {
  const params: StorageBagSearchParams = {
    keyword: '收纳包',
    sortField: 'publishTime',
    sortMethod: 'desc',
    page: 1,
    pageSize: 10
  }
  let picture: ResourceStr = ''
  let isFinished: boolean = false
  do {
    const result: StorageBagSearchResult = await RequestAxios.post<StorageBagSearchResult>(
      '/search/all',
      params
    )
    picture = findStorageBagPicture(result.pageData.items)
    params.page++
    isFinished = result.pageData.pages < params.page
  } while (!picture && !isFinished)
  return picture
}
