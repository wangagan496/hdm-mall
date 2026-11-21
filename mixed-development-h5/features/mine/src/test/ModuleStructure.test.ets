import { describe, it, expect } from '@ohos/hypium'
import { MODULE_STRUCTURE, ModuleStructureEntry } from '../main/ets/presentation/views/ModuleStructure'
export default function moduleStructureTests(): void {
  describe('realModuleStructure', () => {
    it('oneEntryShell', 0, () => {
      const shells = MODULE_STRUCTURE.filter((entry: ModuleStructureEntry) => entry.group === 'shell')
      expect(shells.length).assertEqual(1)
      expect(shells[0].path).assertEqual('products/phone')
      expect(shells[0].type).assertEqual('entry')
    })
    it('fourSharedFeatures', 0, () => {
      const features = MODULE_STRUCTURE.filter((entry: ModuleStructureEntry) => entry.group === 'feature')
      expect(features.length).assertEqual(4)
      expect(features.every((entry: ModuleStructureEntry) => entry.type === 'shared')).assertTrue()
      expect(features.map((entry: ModuleStructureEntry) => entry.name).sort().join(',')).assertEqual('cart,category,home,mine')
    })
    it('sevenCommonsAndCoreBoundaries', 0, () => {
      const commons = MODULE_STRUCTURE.filter((entry: ModuleStructureEntry) => entry.group === 'common')
      expect(commons.length).assertEqual(7)
      expect(commons.every((entry: ModuleStructureEntry) => entry.responsibility.length > 0)).assertTrue()
      const cart = MODULE_STRUCTURE.find((entry: ModuleStructureEntry) => entry.name === 'cart')
      expect(cart?.core.includes('钱、库存、订单')).assertTrue()
    })
  })
}
