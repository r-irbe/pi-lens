package corpus;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

public class Inventory<T extends Comparable<T>> {
    private final List<T> items = new ArrayList<>();

    public void add(T item) {
        if (item == null) {
            throw new IllegalArgumentException("item");
        }
        items.add(item);
    }

    public List<T> sorted() {
        return items.stream().sorted().collect(Collectors.toList());
    }

    public static void main(String[] args) {
        Inventory<String> inventory = new Inventory<>();
        for (String arg : args) {
            inventory.add(arg);
        }
        try {
            System.out.println(inventory.sorted());
        } catch (RuntimeException e) {
            System.err.println(e.getMessage());
        }
    }
}
