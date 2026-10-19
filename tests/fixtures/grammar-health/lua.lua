local M = {}

local Account = {}
Account.__index = Account

function Account.new(balance)
  return setmetatable({ balance = balance or 0 }, Account)
end

function Account:deposit(amount)
  assert(type(amount) == "number", "amount must be a number")
  self.balance = self.balance + amount
  return self
end

for i, name in ipairs({ "a", "b", "c" }) do
  if i % 2 == 0 then
    print(("%d:%s"):format(i, name))
  else
    goto continue
  end
  ::continue::
end

M.account = Account.new(10):deposit(5)
return M
