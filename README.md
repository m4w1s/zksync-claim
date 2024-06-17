# zksync-mint
 
## Как запустить
Для работы требуется установленный Node.js v18 или выше (https://nodejs.org/en/download)

Нужно открыть CMD, перейти в папку с софтом и выполнить следующие команды:

Установка зависимостей
```bash
npm install
```

Запуск
```bash
npm start
```

## Формат кошельков в data/wallets.txt

Адрес для вывода опциональный, если его указать софт выведет все монеты на него после клейма.

```txt
privateKey:withdrawAddress

// Пример

0x0000001
0x0000002:0x0000003
```

## Формат прокси в data/proxies.txt

Прокси опциональные и нужны только для загрузки аллокации с claim.zknation.io

```txt
http://user:pass@127.0.0.1:1234
ИЛИ
127.0.0.1:1234:user:pass
```

## Как изменить RPC или цену газа?
В файле main.js сверху есть переменные `rpcUrl` и `gasPrice`.

Значения по умолчанию:
```js
const rpcUrl = 'https://zksync.drpc.org';
const gasPrice = {
  // Используется при клейме ZK
  claim: {
    maxFeePerGas: ethers.parseUnits('0.25', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.15', 'gwei'),
  },
  // Используется при выводе ZK на указанный адрес
  withdraw: {
    maxFeePerGas: ethers.parseUnits('0.25', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.15', 'gwei'),
  },
};
```
