import {
  AssetWorkerInner,
  type Env,
} from "@distilled.cloud/vendor-workers-shared/workers/asset-worker";

export default class LocalAssetWorker extends AssetWorkerInner<Env> {
  override fetch(request: Request): Promise<Response> {
    return super.fetch(request);
  }
}
