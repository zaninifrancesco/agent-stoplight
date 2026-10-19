// Demo API module. Two sessions fighting over this file is exactly what agent-stoplight prevents.
export function greet(name: string): string {
  return `hello ${name}`
}

export function farewell(name: string): string {
  return `see you, ${name}`
}
