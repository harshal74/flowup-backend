const generateOrderNumber = () => {
  return `ORD-${Date.now()}`;
};

module.exports = generateOrderNumber;