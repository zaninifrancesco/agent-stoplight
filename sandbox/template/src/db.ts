const users = new Map<number, string>([
  [1, 'ada'],
  [2, 'linus'],
])

export function userName(id: number): string | undefined {
  return users.get(id)
}
