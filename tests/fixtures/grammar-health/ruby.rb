# frozen_string_literal: true

module Corpus
  class Account
    attr_reader :balance

    def initialize(balance = 0)
      @balance = balance
    end

    def deposit(amount)
      raise ArgumentError, "bad amount" unless amount.positive?

      @balance += amount
      self
    end
  end
end

accounts = [1, 2, 3].map { |n| Corpus::Account.new.deposit(n) }
total = accounts.sum(&:balance)
case total
when 0 then puts "empty"
when 1..5 then puts "small: #{total}"
else puts "large"
end
