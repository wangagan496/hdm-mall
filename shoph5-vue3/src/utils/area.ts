export interface Area {
  code: string
  level: number
  name: string
  areaList?: Area[]
}

type FlattenedArea = Record<string, string>

export function flattenAreaData(areas: Area[]): FlattenedArea {
  const result: FlattenedArea = {}

  function recursiveFlatten(currentAreas: Area[]): void {
    currentAreas.forEach((area) => {
      // 将当前区域的名称添加到结果对象中
      result[area.code] = area.name

      // 如果当前区域有子区域，递归调用该函数
      if (area.areaList && area.areaList.length > 0) {
        recursiveFlatten(area.areaList)
      }
    })
  }

  recursiveFlatten(areas)
  return result
}

