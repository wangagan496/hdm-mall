import { CategoryItem, CategoryItemChild } from 'models'

export const STORAGE_BAG_KEYWORD_CATEGORY_ID: string = '__keyword_storage_bag__'

export function findCategoryIndexById(categories: CategoryItem[], categoryId: string): number {
  return categories.findIndex((category: CategoryItem): boolean => category.id === categoryId)
}

export function renameSunHatCategory(categories: CategoryItem[]): CategoryItem[] {
  return categories.map((category: CategoryItem): CategoryItem => {
    return {
      id: category.id,
      name: category.name,
      picture: category.picture,
      goods: category.goods,
      children: (category.children || []).map((child: CategoryItemChild): CategoryItemChild => {
        if (child.name !== '草帽') {
          return child
        }
        return {
          id: child.id,
          name: '遮阳帽',
          picture: child.picture,
          goods: child.goods
        }
      })
    }
  })
}

function findBagCategoryIndex(categories: CategoryItem[]): number {
  const handbagParentIndex: number = categories.findIndex((category: CategoryItem): boolean => {
    return (category.children || []).some((child: CategoryItemChild): boolean => {
      return child.name.includes('手提包')
    })
  })
  if (handbagParentIndex >= 0) {
    return handbagParentIndex
  }
  return categories.findIndex((category: CategoryItem): boolean => {
    if (category.name.includes('包')) {
      return true
    }
    return (category.children || []).some((child: CategoryItemChild): boolean => child.name.includes('包'))
  })
}

export function addStorageBagCategory(
  categories: CategoryItem[],
  picture: ResourceStr
): CategoryItem[] {
  const alreadyExists: boolean = categories.some((category: CategoryItem): boolean => {
    return (category.children || []).some((child: CategoryItemChild): boolean => child.name === '收纳包')
  })
  if (alreadyExists) {
    return categories
  }

  const storageBag: CategoryItemChild = {
    id: STORAGE_BAG_KEYWORD_CATEGORY_ID,
    name: '收纳包',
    picture
  }
  const parentIndex: number = findBagCategoryIndex(categories)
  if (parentIndex < 0) {
    return [
      ...categories,
      {
        id: '__local_bag_category__',
        name: '箱包',
        picture,
        children: [storageBag]
      }
    ]
  }

  return categories.map((category: CategoryItem, index: number): CategoryItem => {
    if (index !== parentIndex) {
      return category
    }
    return {
      id: category.id,
      name: category.name,
      picture: category.picture,
      goods: category.goods,
      children: [...(category.children || []), storageBag]
    }
  })
}

export function isStorageBagKeywordCategory(categoryId: string): boolean {
  return categoryId === STORAGE_BAG_KEYWORD_CATEGORY_ID
}

export function updateStorageBagCategoryPicture(
  categories: CategoryItem[],
  picture: ResourceStr
): CategoryItem[] {
  return categories.map((category: CategoryItem): CategoryItem => {
    const children: CategoryItemChild[] = category.children || []
    const hasStorageBag: boolean = children.some((child: CategoryItemChild): boolean => {
      return isStorageBagKeywordCategory(child.id)
    })
    if (!hasStorageBag) {
      return category
    }
    return {
      id: category.id,
      name: category.name,
      picture: category.picture,
      goods: category.goods,
      children: children.map((child: CategoryItemChild): CategoryItemChild => {
        if (!isStorageBagKeywordCategory(child.id)) {
          return child
        }
        return {
          id: child.id,
          name: child.name,
          picture,
          goods: child.goods
        }
      })
    }
  })
}
