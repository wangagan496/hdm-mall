import { AfterSaleImage } from 'models'
@Component
export struct AfterSalePhotos {
  @Prop images: AfterSaleImage[] = []
  loadImage: (path:string)=>Promise<string> = async ():Promise<string>=>''
  @State sources: string[] = []
  @State failed: boolean = false
  private active: boolean = false
  private sequence: number = 0
  aboutToAppear():void{this.active=true;void this.load()}
  aboutToDisappear():void{this.active=false;this.sequence++;this.sources=[]}
  private async load():Promise<void>{
    const seq=++this.sequence;this.sources=[];this.failed=false
    try{for(const image of this.images){const value=await this.loadImage(image.path);if(!this.active||seq!==this.sequence)return;this.sources=this.sources.concat([value])}}
    catch{if(this.active&&seq===this.sequence)this.failed=true}
  }
  build(){
    Column({space:8}){
      ForEach(this.sources,(source:string)=>{Image(source).width('100%').height(200).objectFit(ImageFit.Contain)})
      if(this.failed){Text('照片暂未加载').fontColor($r('app.color.text'));Button('重试加载照片').onClick(()=>this.load())}
    }.width('100%')
  }
}
