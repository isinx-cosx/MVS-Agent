#include <iostream>
#include <cstdlib>
#include <ctime>

// 生成1到100之间的随机数
int generateRandomNumber() {
    return rand() % 100 + 1;
}

// 主函数
int main() {
    // 初始化随机数生成器
    std::srand(std::time(0));

    // 生成随机数
    int randomNumber = generateRandomNumber();
    int guess;
    int attempts = 0;
    std::cout << "欢迎来到猜数字游戏！\n";

    do {
        std::cout << "请输入你的猜测（1-100）：";
        std::cin >> guess;
        attempts++;

        if (guess < randomNumber) {
            std::cout << "太低了！\n";
        } else if (guess > randomNumber) {
            std::cout << "太高了！\n";
        } else {
            std::cout << "恭喜，你猜对了！\n";
        }
    } while (guess != randomNumber);

    std::cout << "你总共尝试了 " << attempts << " 次。\n";
    return 0;
}