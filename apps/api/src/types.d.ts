declare module "heic-convert" {
  interface Options {
    buffer: Buffer | ArrayBufferLike;
    format: "JPEG" | "PNG";
    quality?: number;
  }
  export default function convert(opts: Options): Promise<ArrayBuffer>;
}
