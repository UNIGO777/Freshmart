module.exports = {
  apps: [
    {
      name: "zipmart-gateway",
      script: "./gateway/index.js",
    },
    {
      name: "zipmart-auth",
      script: "./services/auth/index.js",
    },
    {
      name: "zipmart-user",
      script: "./services/user/index.js",
    },
    {
      name: "zipmart-product",
      script: "./services/product/index.js",
    },
    {
      name: "zipmart-order",
      script: "./services/order/index.js",
    },
    {
      name: "zipmart-vendor",
      script: "./services/vendor/index.js",
    },
    {
      name: "zipmart-delivery",
      script: "./services/delivery/index.js",
    },
    {
      name: "zipmart-payment",
      script: "./services/payment/index.js",
    },
    {
      name: "zipmart-notification",
      script: "./services/notification/index.js",
    },
    {
      name: "zipmart-admin",
      script: "./services/admin/index.js",
    },
    {
      name: "zipmart-socket",
      script: "./services/socket/index.js",
    },
    {
      name: "zipmart-panel-notify",
      script: "./services/panel-notify/index.js",
    }
  ]
};
