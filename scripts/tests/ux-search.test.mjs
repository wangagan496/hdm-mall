import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods} from './native-harness.mjs'
const path='mixed-development-h5/features/home/src/main/ets/presentation/views/SearchResultView.ets'
test('UX21 空结果按原入口命名，清除分类保留排序并重建查询',()=>{
 const Page=pageMethods(path,'SearchResultView',{}, {GlobalVariable:{},ListDataSource:class{},Scroller:class{},PAGE_PATH:{SEARCH_RESULT_PAGE:'result'}})
 const p=new Page();let reload=0;p.loadNextSearchPage=()=>{};p.stackPath={getParamByName:()=>[{categoryId:'cat'}]};p.aboutToAppear()
 assert.equal(p.backLabel(),'返回分类');assert.equal(p.emptyActionLabel(),'清除筛选');assert.equal(p.emptyResultTip(),'这个分类下暂时没有商品')
 p.params.sortField='price';p.restartSearch=()=>reload++;p.resolveEmpty();assert.equal(p.params.categoryId,undefined);assert.equal(p.params.sortField,'price');assert.equal(reload,1);assert.equal(p.backLabel(),'返回分类')
 p.stackPath={getParamByName:()=>[{keyword:'找不到'}]};p.aboutToAppear();assert.equal(p.backLabel(),'返回搜索');assert.equal(p.emptyActionLabel(),'修改关键词');assert.equal(p.emptyResultTip(),'没有找到相关商品，换个关键词试试')
 p.resolveEmpty();assert.equal(p.searchInput,'');assert.equal(p.params.keyword,'找不到');assert.equal(reload,1)
})
