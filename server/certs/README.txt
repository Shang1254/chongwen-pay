这个文件夹放微信支付证书，**千万不要发给别人，也不要上传到网盘/代码仓库**。

正式上线前需要放进来两个文件：

1. `apiclient_key.pem`
   商户 API 私钥。微信支付商户平台 → 账户中心 → API安全 → API证书 → 申请证书，
   用官方工具生成后会得到一个压缩包，里面 apiclient_key.pem 就是它。

2. `wechatpay_pub.pem`
   微信支付公钥（2024 年后新商户）或平台证书公钥（老商户）。
   商户平台 → 账户中心 → API安全 → 微信支付公钥 → 下载。
   下载后把公钥内容保存成这个文件名。

放好后，在 server/config.js 里确认：
- wechatPay.privateKeyPath: './certs/apiclient_key.pem'
- wechatPay.platformPublicKeyPath: './certs/wechatpay_pub.pem'
- wechatPay.serialNo: 商户API证书序列号
- wechatPay.platformPublicKeyId: 微信支付公钥ID（PUB_KEY_ID_ 开头）
- wechatPay.apiV3Key: 32 位
- wechatPay.notifyUrl: https://你的域名/api/pay/notify
然后把 mockMode 改为 false，重启后端。启动自检会告诉你还缺什么。

⚠️ 服务器被入侵 = 别人能拿你的商户号收款/退款。证书文件权限建议 600。
