/** Repo-kit YAML bundled as text (`import x from "….yml" with { type: "text" }`). */
declare module "*.yml" {
  const text: string;
  export default text;
}
