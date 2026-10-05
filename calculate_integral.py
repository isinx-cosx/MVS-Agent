from sympy import symbols, sin, cos, integrate, init_printing

# 初始化打印（让输出更美观）
init_printing()

# 定义符号变量
x = symbols('x')

# 定义被积函数
f = x * sin(x)

# 计算不定积分
result = integrate(f, x)

# 打印结果
print("被积函数:", f)
print("积分结果:", result)

# 验证：对结果求导，应该回到原函数
derivative = result.diff(x)
print("对结果求导:", derivative)
print("简化后:", derivative.simplify())
