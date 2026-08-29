declare module "picomatch" {
  type Options = Readonly<{ dot?: boolean; nocase?: boolean }>
  type Matcher = (value: string) => boolean
  export default function picomatch(pattern: string, options?: Options): Matcher
}
