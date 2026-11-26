# Echo the validated input text and identify the Python runtime in the result.
# 返回已校验的输入文本，并在结果中标明使用 Python 运行时。
def echo(args, context):
    return {"text": args["text"], "runtime": "python"}
