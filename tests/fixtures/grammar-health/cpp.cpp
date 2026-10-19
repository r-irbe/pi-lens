#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace corpus {

template <typename T>
class Stack {
public:
	void push(T value) { items_.push_back(std::move(value)); }
	[[nodiscard]] bool empty() const noexcept { return items_.empty(); }

private:
	std::vector<T> items_;
};

}  // namespace corpus

int main() {
	corpus::Stack<std::string> stack;
	std::map<std::string, int> counts{{"a", 1}, {"b", 2}};
	auto total = [&counts](int base) {
		for (const auto &[key, count] : counts) {
			base += count + static_cast<int>(key.size());
		}
		return base;
	};
	stack.push("x");
	return total(0) > 0 ? 0 : 1;
}
