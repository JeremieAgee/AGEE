export type ComponentSchema = Record<string, "f32" | "f64" | "i32" | "u8" | "bool" | "ref">;

export interface ComponentDef<S extends ComponentSchema = ComponentSchema> {
  name: string;
  schema: S;
}

export function defineComponent<S extends ComponentSchema>(
  name: string,
  schema: S
): ComponentDef<S> {
  return { name, schema };
}
