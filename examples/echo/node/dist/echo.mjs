// Echo the validated input text and identify the Node runtime in the result.
// 返回已校验的输入文本，并在结果中标明使用 Node 运行时。
export function echo(args) {
  return { text: args.text, runtime: 'node' }
}
