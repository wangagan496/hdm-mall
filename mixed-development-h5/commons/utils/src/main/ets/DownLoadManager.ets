import { request } from "@kit.BasicServicesKit"
import { common } from "@kit.AbilityKit"
import { util } from "@kit.ArkTS"

export class DownLoadManager {
  async downLoadImages(context: common.UIAbilityContext, list: string[]) {
    const taskList = list.map((url): Promise<string | null> =>
      this.downloadSingle(context, url).catch((): null => null)
    )
    const results = await Promise.all(taskList)
    const paths: string[] = []
    for (const p of results) {
      if (p !== null) {
        paths.push(p as string)
      }
    }
    return paths
  }

  private downloadSingle(context: common.UIAbilityContext, url: string) {
    return new Promise<string>(async (resolve, reject) => {
      let savePath = context.tempDir + "/" + util.generateRandomUUID() + ".jpg"
      const task = await request.downloadFile(context, {
        url,
        filePath: savePath
      })
      task.on("complete", () => {
        resolve(savePath)
      })
      task.on("fail", () => {
        reject(new Error("下载失败"))
      })
    })
  }
}

export const downLoadManager = new DownLoadManager()