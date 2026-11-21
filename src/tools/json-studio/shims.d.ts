// papaparse ships without bundled types and @types/papaparse is not installed.
declare module 'papaparse' {
  const Papa: any;
  export default Papa;
}
